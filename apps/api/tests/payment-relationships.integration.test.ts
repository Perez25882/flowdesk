import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const dbUrl = process.env.G1_04_TEST_DATABASE_URL;
const cacheUrl = process.env.G1_04_TEST_REDIS_URL;
const upgradeUrl = process.env.G1_04_UPGRADE_DATABASE_URL;
const runWithFixtures = dbUrl || cacheUrl || upgradeUrl ? describe : describe.skip;

const provider = {
  initialize: vi.fn(),
  verify: vi.fn(),
};

function stubPaystackTransport() {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.paystack.co') return originalFetch(input, init);
    if (url.pathname === '/transaction/initialize') {
      const data = JSON.parse(String(init?.body));
      const charge = await provider.initialize({
        reference: data.reference, amountMinor: data.amount,
        subaccountCode: data.subaccount, metadata: JSON.parse(data.metadata),
      });
      return Response.json({ status: true, data: {
        authorization_url: charge.authorizationUrl, access_code: charge.accessCode, reference: charge.reference,
      } });
    }
    if (url.pathname.startsWith('/transaction/verify/')) {
      return Response.json({ status: true, data: await provider.verify(url.pathname.split('/').at(-1)) });
    }
    throw new Error(`Unexpected synthetic Paystack endpoint ${url.pathname}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

runWithFixtures('G1-04 payment relationships with real PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let payments: typeof import('../src/modules/payments/payments.service.js');
  let ledger: typeof import('../src/modules/payments/payments.repository.js');
  let links: typeof import('../src/modules/payments/payment-links.service.js');
  let requests: typeof import('../src/modules/payments/payment-links.repository.js');
  let screenshot: typeof import('../src/modules/payments/screenshot-claims.js');
  let acceptPaystackReceipt: typeof import('../src/modules/payments/paystack-receipts.js').acceptPaystackReceipt;
  let drainPaystackReceipts: typeof import('../src/modules/payments/paystack-settlement.js').drainPaystackReceipts;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let closeConnections: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const trace = (step: string) => { if (process.env.G1_04_DEBUG_SETUP) process.stdout.write(`G1-04 fixture ${step}\n`); };
    for (const url of [dbUrl, cacheUrl, upgradeUrl]) {
      if (!url || new URL(url).hostname !== '127.0.0.1') {
        throw new Error('Use dedicated IPv4 loopback databases and Redis for G1-04');
      }
    }
    process.env.DATABASE_URL = dbUrl!;
    process.env.REDIS_URL = cacheUrl!;
    stubPaystackTransport();
    trace('connecting to PostgreSQL');
    ({ prisma } = await import('../src/config/database.js'));
    await prisma.$connect();
    trace('loading ledger and link services');
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    payments = await import('../src/modules/payments/payments.service.js');
    ledger = await import('../src/modules/payments/payments.repository.js');
    links = await import('../src/modules/payments/payment-links.service.js');
    ({ acceptPaystackReceipt } = await import('../src/modules/payments/paystack-receipts.js'));
    ({ drainPaystackReceipts } = await import('../src/modules/payments/paystack-settlement.js'));
    requests = await import('../src/modules/payments/payment-links.repository.js');
    screenshot = await import('../src/modules/payments/screenshot-claims.js');
    trace('loading authenticated routes');
    const { outboundMessagesQueue } = await import('../src/queues/outbound.queue.js');
    const { disconnectRedis } = await import('../src/config/redis.js');
    closeConnections = async () => {
      await outboundMessagesQueue.close();
      await disconnectRedis();
    };

    const { requireAuth } = await import('../src/middleware/auth.middleware.js');
    const { attachBusinessContext } = await import('../src/middleware/business-context.middleware.js');
    const { isAppError } = await import('../src/utils/errors.js');
    const { default: paymentRoutes } = await import('../src/modules/payments/payments.route.js');
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (isAppError(error)) return reply.status(error.statusCode).send({ code: error.code, error: error.message });
      if (error instanceof ZodError) return reply.status(400).send({ error: error.message });
      return reply.send(error);
    });
    await app.register(async (routes) => {
      routes.addHook('preHandler', requireAuth);
      routes.addHook('preHandler', attachBusinessContext);
      await routes.register(paymentRoutes);
    }, { prefix: '/api/v1' });
    await app.ready();
    trace('ready');
  }, 120_000);

  beforeEach(() => {
    provider.initialize.mockReset().mockImplementation(async (input: { reference: string }) => ({
      authorizationUrl: `https://provider.invalid/${input.reference}`,
      accessCode: 'synthetic-access',
      reference: input.reference,
    }));
    provider.verify.mockReset();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await closeConnections?.();
    await prisma?.$disconnect();
  });

  async function shop() {
    const business = await prisma.business.create({
      data: {
        name: 'Synthetic shop', ownerName: 'Synthetic owner', plan: 'BUSINESS',
        paystackSubaccountCode: `fixture-${randomUUID()}`,
      },
    });
    const first = await prisma.customer.create({ data: { businessId: business.id, waNumber: '233201010001' } });
    const second = await prisma.customer.create({ data: { businessId: business.id, waNumber: '233201010002' } });
    return { id: business.id, first: first.id, second: second.id, subaccount: business.paystackSubaccountCode };
  }

  function order(businessId: string, customerId: string, deletedAt: Date | null = null) {
    return prisma.order.create({
      data: {
        businessId, customerId, referenceNumber: randomUUID(), status: 'CONFIRMED',
        totalAmount: 200, rawMessage: 'Synthetic sale', deletedAt,
      },
    });
  }

  function staff(businessId: string, role: 'MANAGER' | 'OPERATIONS') {
    return prisma.staff.create({
      data: { businessId, name: role, role, phone: role === 'MANAGER' ? '233201010003' : '233201010004' },
    });
  }

  const input = (customerId: string, orderId?: string, amount = 20) => ({
    customerId, orderId, amount, method: 'CASH' as const, direction: 'IN' as const, attested: true,
  });

  function request(
    businessId: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
    actor?: { id: string; role: 'MANAGER' | 'OPERATIONS' | 'DELIVERY' },
  ) {
    const token = sign({
      businessId, plan: 'BUSINESS', ...(actor ? { staffId: actor.id, role: actor.role } : {}),
    }, '15m');
    return app.inject({
      method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function totals(customerId: string, orderId: string) {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return { paid: Number(row.amountPaid), spend: Number(customer.totalSpend), owed: Number(customer.outstandingBalance) };
  }

  async function snapshot(...businessIds: string[]) {
    const scope = { businessId: { in: businessIds } };
    const [customers, orders, payments, requests, activity] = await Promise.all([
      prisma.customer.findMany({ where: scope, orderBy: { id: 'asc' } }),
      prisma.order.findMany({ where: scope, orderBy: { id: 'asc' } }),
      prisma.payment.findMany({ where: scope, orderBy: { id: 'asc' } }),
      prisma.paymentRequest.findMany({ where: scope, orderBy: { id: 'asc' } }),
      prisma.staffActivity.findMany({ where: scope, orderBy: { id: 'asc' } }),
    ]);
    return { customers, orders, payments, requests, activity };
  }

  it('posts a payment to the correct order and commits owner attribution and totals', async () => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    const response = await request(tenant.id, 'POST', '/payments', input(tenant.first, target.id));
    expect(response.statusCode, response.body).toBe(201);
    const { id, order: returnedOrder } = response.json().data;
    expect(Number(returnedOrder.amountPaid)).toBe(20);
    expect(await prisma.payment.findUnique({ where: { id } })).toMatchObject({
      businessId: tenant.id, customerId: tenant.first, orderId: target.id,
      loggedById: null, attestedBy: 'owner', confidence: 'SELLER_ATTESTED',
    });
    expect(await prisma.staffActivity.findFirst({ where: { resourceId: id } })).toMatchObject({
      businessId: tenant.id, staffId: null, action: 'payment.logged',
    });
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 20, spend: 20, owed: 180 });
  });

  it('rejects wrong-customer, foreign, missing and deleted relationships with zero writes', async () => {
    const tenant = await shop();
    const other = await shop();
    const target = await order(tenant.id, tenant.first);
    const foreign = await order(other.id, other.first);
    const archived = await order(tenant.id, tenant.first, new Date());
    const before = await snapshot(tenant.id, other.id);
    const cases = [
      [tenant.second, target.id, 400], [other.first, target.id, 404],
      [tenant.first, foreign.id, 404], [other.first, foreign.id, 404],
      [tenant.first, 'missing-order', 404], [tenant.first, archived.id, 404],
    ] as const;
    for (const [customerId, orderId, code] of cases) {
      const response = await request(tenant.id, 'POST', '/payments', input(customerId, orderId));
      expect(response.statusCode, response.body).toBe(code);
      await expect(payments.logPayment(input(customerId, orderId), tenant.id, null)).rejects.toMatchObject({ statusCode: code });
    }
    await expect(prisma.$transaction((tx) => ledger.createGatewayPayment(tx, tenant.id, {
      customerId: tenant.second, orderId: target.id, amount: 10, method: 'CASH', reference: 'fixture',
    }))).rejects.toMatchObject({ statusCode: 400 });
    const outsider = await staff(other.id, 'MANAGER');
    await expect(payments.logPayment(input(tenant.first, target.id), tenant.id, outsider.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot(tenant.id, other.id)).toEqual(before);
  });

  it('preserves no-order payments, refund direction and owner/staff audit on void', async () => {
    const tenant = await shop();
    const manager = await staff(tenant.id, 'MANAGER');
    const target = await order(tenant.id, tenant.first);
    const credit = await payments.logPayment(input(tenant.first, undefined, 25), tenant.id, manager.id);
    const refund = await payments.logPayment({ ...input(tenant.first, undefined, 10), direction: 'OUT' }, tenant.id, null);
    expect(credit.orderId).toBeNull();
    expect(refund.orderId).toBeNull();
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 0, spend: 15, owed: 185 });
    const response = await request(tenant.id, 'POST', `/payments/${refund.id}/void`, { reason: 'Duplicate refund' });
    expect(response.statusCode, response.body).toBe(204);
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 0, spend: 25, owed: 175 });
    expect(await prisma.payment.findUnique({ where: { id: credit.id } })).toMatchObject({ loggedById: manager.id, attestedBy: manager.id });
    expect(await prisma.payment.findUnique({ where: { id: refund.id } })).toMatchObject({ voidedBy: 'owner' });
    expect(await prisma.staffActivity.findMany({ where: { businessId: tenant.id }, orderBy: { createdAt: 'asc' } }))
      .toMatchObject([
        { staffId: manager.id, action: 'payment.logged' }, { staffId: null, action: 'payment.refunded' },
        { staffId: null, action: 'payment.voided' },
      ]);
  });

  it('confirms exactly one claim under concurrent owner and manager requests', async () => {
    const tenant = await shop();
    const manager = await staff(tenant.id, 'MANAGER');
    const counter = await staff(tenant.id, 'OPERATIONS');
    const target = await order(tenant.id, tenant.first);
    const created = await request(tenant.id, 'POST', '/payments', input(tenant.first), counter);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    expect(await prisma.payment.findUnique({ where: { id } })).toMatchObject({ confidence: 'CLAIMED', loggedById: counter.id, attestedBy: null });
    const path = `/payments/${id}/confirm`;
    const body = { orderId: target.id, amount: 50, method: 'CASH' };
    const replies = await Promise.all([
      request(tenant.id, 'PATCH', path, body, manager),
      request(tenant.id, 'PATCH', path, body),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 400]);
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 50, spend: 50, owed: 150 });
    const audit = await prisma.staffActivity.findMany({ where: { resourceId: id, action: 'payment.attested' } });
    expect(audit).toHaveLength(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id } })).attestedBy).toBe(audit[0]?.staffId ?? 'owner');
  });

  it('keeps claims unchanged when confirmation targets a different customer or tenant', async () => {
    const tenant = await shop();
    const other = await shop();
    const mismatched = await order(tenant.id, tenant.second);
    const foreign = await order(other.id, other.first);
    const archived = await order(tenant.id, tenant.first, new Date());
    const claim = await payments.logPayment({ ...input(tenant.first), attested: false }, tenant.id, null);
    const before = await snapshot(tenant.id, other.id);
    const body = { amount: 60, method: 'CASH' as const };
    for (const [orderId, code] of [[mismatched.id, 400], [foreign.id, 404], [archived.id, 404], ['missing-order', 404]] as const) {
      const response = await request(tenant.id, 'PATCH', `/payments/${claim.id}/confirm`, { ...body, orderId });
      expect(response.statusCode, response.body).toBe(code);
      await expect(payments.confirmPayment(claim.id, tenant.id, { ...body, orderId }, null)).rejects.toMatchObject({ statusCode: code });
    }
    await expect(payments.attestPayment(claim.id, other.id, null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(payments.voidPayment(claim.id, other.id, null, 'Invalid access')).rejects.toMatchObject({ statusCode: 404 });
    expect(await snapshot(tenant.id, other.id)).toEqual(before);
  });

  it('attests a valid existing claim and confirms a screenshot without an order', async () => {
    const tenant = await shop();
    const manager = await staff(tenant.id, 'MANAGER');
    const target = await order(tenant.id, tenant.first);
    const claim = await payments.logPayment({ ...input(tenant.first, target.id), attested: false }, tenant.id, null);
    const attested = await request(tenant.id, 'PATCH', `/payments/${claim.id}/attest`, undefined, manager);
    expect(attested.statusCode, attested.body).toBe(200);

    const context = {
      businessId: tenant.id, customerId: tenant.first,
      screenshotKey: `fixture/${randomUUID()}`, detectionConfidence: 0.8, reasons: ['Synthetic image'],
    };
    const duplicates = await Promise.all([screenshot.recordScreenshotClaim(context), screenshot.recordScreenshotClaim(context)]);
    expect(duplicates.map((result) => result.created).sort()).toEqual([false, true]);
    expect(duplicates[0]?.paymentId).toBe(duplicates[1]?.paymentId);
    const shotId = duplicates[0]!.paymentId;
    await expect(payments.attestPayment(shotId, tenant.id, null)).rejects.toThrow(/no amount yet/);
    await expect(screenshot.recordScreenshotClaim({ ...context, customerId: tenant.second })).rejects.toMatchObject({ statusCode: 400 });
    const confirmed = await request(tenant.id, 'PATCH', `/payments/${shotId}/confirm`, { amount: 25, method: 'CASH' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().data.orderId).toBeNull();
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 20, spend: 45, owed: 155 });
  });

  it('serializes concurrent distinct credits for one order and customer', async () => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    await Promise.all([10, 20, 30, 40].map((amount) => payments.logPayment(input(tenant.first, target.id, amount), tenant.id, null)));
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 100, spend: 100, owed: 100 });
    expect(await prisma.payment.count({ where: { businessId: tenant.id } })).toBe(4);
  });

  it('rolls back ledger, balance and audit when the final audit insert fails', async () => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    const before = await snapshot(tenant.id);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE staff_activity ADD CONSTRAINT fixture_reject_payment_log CHECK (action <> 'payment.logged') NOT VALID`,
    );
    try {
      await expect(payments.logPayment(input(tenant.first, target.id), tenant.id, null)).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE staff_activity DROP CONSTRAINT fixture_reject_payment_log');
    }
    expect(await snapshot(tenant.id)).toEqual(before);
  });

  it('rejects invalid hosted requests before any provider call', async () => {
    const tenant = await shop();
    const other = await shop();
    const local = await order(tenant.id, tenant.first);
    const foreign = await order(other.id, other.first);
    const archived = await order(tenant.id, tenant.first, new Date());
    const before = await snapshot(tenant.id, other.id);
    for (const [customerId, orderId, code] of [
      [tenant.second, local.id, 400], [other.first, local.id, 404],
      [tenant.first, foreign.id, 404], [tenant.first, archived.id, 404],
    ] as const) {
      const body = { customerId, orderId, amount: 20, send: false };
      const response = await request(tenant.id, 'POST', '/payments/links', body);
      expect(response.statusCode, response.body).toBe(code);
      await expect(links.createPaymentLink(tenant.id, body, null)).rejects.toMatchObject({ statusCode: code });
    }
    expect(provider.initialize).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
    expect(await snapshot(tenant.id, other.id)).toEqual(before);
  });

  it('creates and reuses an order link under concurrency and preserves a no-order link', async () => {
    const tenant = await shop();
    const manager = await staff(tenant.id, 'MANAGER');
    const target = await order(tenant.id, tenant.first);
    const body = { customerId: tenant.first, orderId: target.id, amount: 25, send: false };
    const replies = await Promise.all([
      request(tenant.id, 'POST', '/payments/links', body, manager),
      request(tenant.id, 'POST', '/payments/links', body, manager),
    ]);
    for (const reply of replies) expect(reply.statusCode, reply.body).toBe(201);
    const first = replies[0]!.json().data;
    expect(replies[1]!.json().data.id).toBe(first.id);
    expect(provider.initialize).toHaveBeenCalledTimes(1);
    expect(provider.initialize).toHaveBeenCalledWith(expect.objectContaining({
      amountMinor: 2500, subaccountCode: tenant.subaccount,
      metadata: expect.objectContaining({ flowdeskBusinessId: tenant.id, flowdeskCustomerId: tenant.first, flowdeskOrderId: target.id }),
    }));
    const credit = await links.createPaymentLink(tenant.id, { customerId: tenant.first, amount: 5, send: false }, null);
    expect(credit.orderId).toBeNull();
    expect(await prisma.payment.count({ where: { businessId: tenant.id } })).toBe(0);
    expect(await prisma.paymentRequest.findUnique({ where: { id: first.id } })).toMatchObject({ createdByStaffId: manager.id });
    expect(await prisma.staffActivity.findMany({ where: { businessId: tenant.id, action: 'payment.link_created' }, orderBy: { createdAt: 'asc' } }))
      .toMatchObject([{ staffId: manager.id, resourceId: first.id }, { staffId: null, resourceId: credit.id }]);
    const cancellation = await request(tenant.id, 'DELETE', `/payments/links/${credit.id}`);
    expect(cancellation.statusCode, cancellation.body).toBe(204);
    expect(await prisma.paymentRequest.findUnique({ where: { id: credit.id } })).toMatchObject({ status: 'CANCELLED' });
  });

  it.each(['manual', 'hosted'] as const)('rejects %s if archiving wins the order lock', async (kind) => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    const locked = deferred<number>();
    const release = deferred<void>();
    const archive = prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.order.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
      locked.resolve(pid);
      await release.promise;
    }, { timeout: 12_000 });

    const pid = await Promise.race([locked.promise, archive.then(() => { throw new Error('Archive ended before locking'); })]);
    const attempt = kind === 'manual'
      ? request(tenant.id, 'POST', '/payments', input(tenant.first, target.id))
      : request(tenant.id, 'POST', '/payments/links', { customerId: tenant.first, orderId: target.id, amount: 20, send: false });
    try {
      await vi.waitFor(async () => {
        const [{ blocked }] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR NO KEY UPDATE%') AS blocked
        `;
        expect(blocked).toBe(true);
      }, { timeout: 3500 });
    } finally {
      release.resolve();
      await archive;
      await attempt;
    }
    const response = await attempt;
    expect(response.statusCode, response.body).toBe(404);
    expect(provider.initialize).not.toHaveBeenCalled();
    const state = await snapshot(tenant.id);
    expect(state.payments).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
    expect(state.activity).toHaveLength(0);
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 0, spend: 0, owed: 0 });
  });

  it('settles the correct existing request once with synthetic verification and exact linkage', async () => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    const link = await links.createPaymentLink(tenant.id, { customerId: tenant.first, orderId: target.id, amount: 25, send: false }, null);
    provider.verify.mockResolvedValue({
      id: '61503', reference: link.reference, domain: 'test', status: 'success', amount: 2500,
      currency: 'GHS', channel: 'card', paid_at: new Date().toISOString(),
      subaccount: { subaccount_code: tenant.subaccount },
    });
    const callback = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: link.reference, id: 61503 } }));
    await acceptPaystackReceipt(callback, link.reference, { id: 61503 });
    await drainPaystackReceipts(tenant.id);
    await acceptPaystackReceipt(callback, link.reference, { id: 61503 });
    await drainPaystackReceipts(tenant.id);
    const settled = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: link.id } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: settled.paymentId! } });
    expect(settled.status).toBe('PAID');
    expect(payment).toMatchObject({ businessId: tenant.id, customerId: tenant.first, orderId: target.id, reference: link.reference, attestedBy: 'paystack' });
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(await totals(tenant.first, target.id)).toEqual({ paid: 25, spend: 25, owed: 175 });
    await expect(prisma.payment.update({ where: { id: payment.id }, data: { orderId: null } })).rejects.toThrow();

    const unrelated = await links.createPaymentLink(tenant.id, { customerId: tenant.first, amount: 5, send: false }, null);
    await expect(prisma.paymentRequest.update({ where: { id: unrelated.id }, data: { paymentId: payment.id } })).rejects.toThrow();
    const unlinked = await prisma.$transaction((tx) => ledger.createGatewayPayment(tx, tenant.id, {
      customerId: tenant.first, orderId: target.id, amount: 5, method: 'CARD', reference: unrelated.reference,
    }));
    await expect(prisma.paymentRequest.update({ where: { id: unrelated.id }, data: { paymentId: unlinked.id } })).rejects.toThrow();
    expect((await requests.findById(unrelated.id, tenant.id))?.paymentId).toBeNull();
  });

  it('rejects settlement on an archived order before provider verification or a claim', async () => {
    const tenant = await shop();
    const target = await order(tenant.id, tenant.first);
    const link = await links.createPaymentLink(tenant.id, { customerId: tenant.first, orderId: target.id, amount: 25, send: false }, null);
    await prisma.order.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    const before = await snapshot(tenant.id);
    await acceptPaystackReceipt(Buffer.from(link.reference), link.reference, {});
    await drainPaystackReceipts(tenant.id);
    expect(await prisma.paystackReceipt.findFirst({ where: { reference: link.reference } })).toMatchObject({
      state: 'REVIEW', reason: 'LOCAL_RELATIONSHIP_INVALID',
    });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(await snapshot(tenant.id)).toEqual(before);
  });

  it('enforces relationship constraints for direct database writes', async () => {
    const tenant = await shop();
    const other = await shop();
    const target = await order(tenant.id, tenant.first);
    const base = { businessId: tenant.id, customerId: tenant.first, orderId: target.id, amount: 1, method: 'CASH' as const };
    await expect(prisma.payment.create({ data: { ...base, customerId: tenant.second } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.payment.create({ data: { ...base, customerId: other.first, orderId: null } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.paymentRequest.create({ data: {
      businessId: tenant.id, customerId: tenant.second, orderId: target.id, amount: 1,
      reference: randomUUID(), authorizationUrl: 'https://provider.invalid', expiresAt: new Date(),
    } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.payment.count({ where: { businessId: tenant.id } })).toBe(0);
    expect(await prisma.paymentRequest.count({ where: { businessId: tenant.id } })).toBe(0);
  });

  it('preserves legacy upgrade rows and enforces new writes without retroactive validation', async () => {
    const upgrade = new PrismaClient({ datasourceUrl: upgradeUrl! });
    try {
      expect(await upgrade.payment.findUnique({ where: { id: 'g104-legacy-mismatch' } })).toMatchObject({
        businessId: 'g104-legacy-shop', customerId: 'g104-legacy-second', orderId: 'g104-legacy-order',
      });
      expect(await upgrade.payment.findUnique({ where: { id: 'g104-legacy-credit' } })).toMatchObject({ orderId: null });
      expect(await upgrade.paymentRequest.findUnique({ where: { id: 'g104-legacy-request' } })).toMatchObject({ paymentId: 'g104-legacy-credit' });
      const { findOrderById } = await import('../src/modules/orders/orders.repository.js');
      const visible = await upgrade.$transaction((tx) => findOrderById('g104-legacy-order', 'g104-legacy-shop', { tx }));
      expect(visible?.payments.map(({ id }) => id)).toEqual(['g104-legacy-mismatch']);
      expect(await upgrade.staffActivity.findUnique({ where: { id: 'g104-legacy-activity' } })).toMatchObject({
        staffId: 'g104-legacy-staff', businessId: null,
      });
      await expect(upgrade.payment.create({ data: {
        businessId: 'g104-legacy-shop', customerId: 'g104-legacy-second', orderId: 'g104-legacy-order',
        amount: 1, method: 'CASH',
      } })).rejects.toMatchObject({ code: 'P2003' });
      const newCredit = await upgrade.payment.create({ data: {
        businessId: 'g104-legacy-shop', customerId: 'g104-legacy-first', amount: 1, method: 'CASH',
      } });
      expect(newCredit.orderId).toBeNull();
      await upgrade.payment.delete({ where: { id: newCredit.id } });
    } finally {
      await upgrade.$disconnect();
    }
  });
});
