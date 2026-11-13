import { fork } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dbUrl = process.env.G1_03_TEST_DATABASE_URL;
const redisUrl = process.env.G1_03_TEST_REDIS_URL;
const upgradeUrl = process.env.G1_03_UPGRADE_DATABASE_URL;
const secret = 'sk_test_flowdesk_g103_synthetic';
const fixtureOnly = dbUrl || redisUrl || upgradeUrl ? describe : describe.skip;
const maxId = '18446744073709551615';

fixtureOnly('G1-03 durable Paystack settlement with PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let providerServer: Server;
  let origin: string;
  let drain: typeof import('../src/modules/payments/paystack-settlement.js').drainPaystackReceipts;
  let claim: typeof import('../src/modules/payments/paystack-receipts.js').claimPaystackReceipt;
  let links: typeof import('../src/modules/payments/payment-links.service.js');
  let ledger: typeof import('../src/modules/payments/payments.service.js');
  let redis: typeof import('../src/config/redis.js').redis;
  let outboundQueue: typeof import('../src/queues/outbound.queue.js').outboundMessagesQueue;
  let drainNotifications: typeof import('../src/workers/paystack-settlement.worker.js').drainPaystackNotifications;
  let closeRedis: (() => Promise<void>) | undefined;
  let sequence = 80000;
  const responses = new Map<string, { body: string; status: number; delayMs?: number }>();
  const verificationCalls = new Map<string, number>();
  const initializationCalls: string[] = [];
  let failInitialization = false;

  beforeAll(async () => {
    for (const url of [dbUrl, redisUrl, upgradeUrl]) {
      if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Use dedicated IPv4 loopback fixtures');
    }
    process.env.DATABASE_URL = dbUrl!;
    process.env.REDIS_URL = redisUrl!;
    process.env.PAYSTACK_SECRET_KEY = secret;
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_flowdesk_g103_synthetic';
    ({ prisma } = await import('../src/config/database.js'));
    await prisma.$connect();
    ({ redis } = await import('../src/config/redis.js'));
    const { disconnectRedis } = await import('../src/config/redis.js');
    ({ outboundMessagesQueue: outboundQueue } = await import('../src/queues/outbound.queue.js'));
    closeRedis = async () => { await outboundQueue.close(); await disconnectRedis(); };
    ({ drainPaystackReceipts: drain } = await import('../src/modules/payments/paystack-settlement.js'));
    ({ claimPaystackReceipt: claim } = await import('../src/modules/payments/paystack-receipts.js'));
    ({ drainPaystackNotifications: drainNotifications } = await import('../src/workers/paystack-settlement.worker.js'));
    links = await import('../src/modules/payments/payment-links.service.js');
    ledger = await import('../src/modules/payments/payments.service.js');

    providerServer = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/transaction/initialize') {
        let raw = '';
        req.on('data', (chunk) => { raw += String(chunk); });
        req.on('end', () => {
          const { reference } = JSON.parse(raw);
          initializationCalls.push(reference);
          res.statusCode = failInitialization ? 503 : 200;
          res.end(JSON.stringify({
            status: !failInitialization,
            data: { reference, authorization_url: 'https://checkout.invalid/' + reference, access_code: 'fixture' },
          }));
        });
        return;
      }
      const reference = decodeURIComponent(req.url?.split('/').at(-1) ?? '');
      verificationCalls.set(reference, (verificationCalls.get(reference) ?? 0) + 1);
      const response = responses.get(reference) ?? { status: 503, body: '{}' };
      const send = () => { if (!res.destroyed) { res.statusCode = response.status; res.end(response.body); } };
      if (response.delayMs) setTimeout(send, response.delayMs).unref();
      else send();
    });
    providerServer.listen(0, '127.0.0.1');
    await once(providerServer, 'listening');
    origin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === 'api.paystack.co') return originalFetch(new URL(url.pathname, origin), options);
      return originalFetch(input, options);
    });

    const { default: billingRoutes } = await import('../src/modules/billing/billing.route.js');
    app = Fastify();
    await app.register(import('fastify-raw-body'), { field: 'rawBody', global: false, encoding: false, runFirst: true });
    await app.register(billingRoutes, { prefix: '/api/v1' });
    await app.ready();
    await redis.ping();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    if (providerServer) {
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    }
    await closeRedis?.();
    await prisma?.$disconnect();
  });

  async function shop(noOrder = false) {
    const tenant = await prisma.business.create({
      data: {
        name: 'Synthetic shop', ownerName: 'Fixture', receiptsEnabled: false,
        paystackSubaccountCode: `ACCT_${randomUUID()}`,
      },
    });
    const customer = await prisma.customer.create({ data: { businessId: tenant.id, waNumber: '233201111111' } });
    const order = noOrder ? null : await prisma.order.create({
      data: {
        businessId: tenant.id, customerId: customer.id, referenceNumber: randomUUID(), rawMessage: 'Fixture',
        status: 'CONFIRMED', totalAmount: 100,
      },
    });
    const request = await prisma.paymentRequest.create({
      data: {
        businessId: tenant.id, customerId: customer.id, orderId: order?.id ?? null, amount: 25,
        reference: `fdpay-${randomUUID()}`, authorizationUrl: 'https://checkout.invalid',
        expiresAt: new Date(Date.now() + 3_600_000), subaccountCode: tenant.paystackSubaccountCode,
      },
    });
    return { tenant, customer, order, request, transactionId: String(++sequence) };
  }

  type Fixture = Awaited<ReturnType<typeof shop>>;

  function verify(
    fixture: Fixture,
    overrides: Record<string, unknown> = {},
    options: { status?: number; delayMs?: number } = {},
  ) {
    const data = {
      id: fixture.transactionId, domain: 'test', reference: fixture.request.reference, amount: 2500,
      currency: 'GHS', status: 'success', paid_at: new Date().toISOString(),
      subaccount: { subaccount_code: fixture.tenant.paystackSubaccountCode },
      channel: 'card', fees: 100,
      metadata: {
        flowdeskBusinessId: fixture.tenant.id, flowdeskCustomerId: fixture.customer.id,
        ...(fixture.order ? { flowdeskOrderId: fixture.order.id } : {}),
      },
      ...overrides,
    };
    const body = JSON.stringify({ status: true, data }).replace(`"${maxId}"`, maxId);
    responses.set(fixture.request.reference, { body, status: options.status ?? 200, ...options });
  }

  function payload(reference: string, id?: string, nonce = 0, event = 'charge.success') {
    return JSON.stringify({ event, data: { reference, id, amount: 999999, nonce } }).replace(`"${maxId}"`, maxId);
  }

  function signed(body: string, valid = true) {
    return app.inject({
      method: 'POST', url: '/api/v1/webhooks/paystack', payload: body,
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': createHmac('sha512', valid ? secret : 'wrong').update(body).digest('hex'),
      },
    });
  }

  async function accept(fixture: Fixture, nonce = 0) {
    const reply = await signed(payload(fixture.request.reference, fixture.transactionId, nonce));
    expect(reply.statusCode, reply.body).toBe(200);
  }

  function receipt(fixture: Fixture) {
    return prisma.paystackReceipt.findFirstOrThrow({ where: { reference: fixture.request.reference } });
  }

  async function due(fixture: Fixture) {
    await prisma.paystackReceipt.updateMany({
      where: { reference: fixture.request.reference, state: 'WAITING' },
      data: { nextAttemptAt: new Date(0) },
    });
  }

  async function expectCredit(fixture: Fixture, count: number) {
    const { tenant, customer, order, request } = fixture;
    const live = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(await prisma.payment.count({ where: { businessId: tenant.id, reference: request.reference } })).toBe(count);
    expect(await prisma.paystackSettlement.count({ where: { requestId: request.id } })).toBe(count);
    const buyer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(buyer.totalSpend)).toBe(count * 25);
    if (order) {
      const sale = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(sale.amountPaid)).toBe(count * 25);
      if (count) expect(Number(buyer.outstandingBalance)).toBe(75);
    }
    if (count) {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: live.paymentId! } });
      expect(payment).toMatchObject({
        businessId: tenant.id, customerId: customer.id, orderId: order?.id ?? null,
        confidence: 'GATEWAY_CONFIRMED', attestedBy: 'paystack',
      });
      expect(Number(payment.amount)).toBe(25);
      expect(live.status).toBe('PAID');
    } else {
      expect(live.paymentId).toBeNull();
    }
  }

  it('acknowledges a committed receipt before verification and settles one exact uint64 transaction', async () => {
    const fixture = await shop();
    fixture.transactionId = maxId;
    verify(fixture);
    await accept(fixture);
    expect(await receipt(fixture)).toMatchObject({ state: 'PENDING', callbackTransactionId: maxId, requestId: fixture.request.id });
    expect(verificationCalls.get(fixture.request.reference)).toBeUndefined();
    await expectCredit(fixture, 0);
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
    expect(await receipt(fixture)).toMatchObject({ state: 'SETTLED', evidence: { transactionId: maxId, amountMinor: 2500 } });
    expect(await prisma.paystackSettlement.findUnique({ where: { transactionId: maxId } }))
      .toMatchObject({ notificationState: 'PENDING', requestId: fixture.request.id });
    await drainNotifications();
    expect(await prisma.paystackSettlement.findUnique({ where: { transactionId: maxId } })).toMatchObject({ notificationState: 'SUPPRESSED' });
  });

  it('rejects an invalid signature and ignores unsupported events without financial effects', async () => {
    const fixture = await shop();
    expect((await signed(payload(fixture.request.reference, fixture.transactionId), false)).statusCode).toBe(401);
    expect((await signed(payload(fixture.request.reference, fixture.transactionId, 0, 'refund.processed'))).statusCode).toBe(200);
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference } })).toBe(0);
    await expectCredit(fixture, 0);
  });

  it('returns 503 when the durable receipt insert fails and accepts the exact retry', async () => {
    const fixture = await shop();
    await prisma.$executeRawUnsafe(`ALTER TABLE paystack_receipts ADD CONSTRAINT fixture_receipt_failure CHECK (state <> 'PENDING') NOT VALID`);
    try {
      expect((await signed(payload(fixture.request.reference, fixture.transactionId))).statusCode).toBe(503);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE paystack_receipts DROP CONSTRAINT fixture_receipt_failure');
    }
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference } })).toBe(0);
    await expectCredit(fixture, 0);
    await accept(fixture);
    verify(fixture);
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
  });

  it('keeps accepted events waiting on provider failure and recovers a no-order payment', async () => {
    const fixture = await shop(true);
    await accept(fixture);
    await drain(fixture.tenant.id);
    expect(await receipt(fixture)).toMatchObject({ state: 'WAITING', reason: 'VERIFICATION_UNAVAILABLE' });
    await expectCredit(fixture, 0);
    verify(fixture);
    await due(fixture);
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
    expect(await receipt(fixture)).toMatchObject({ state: 'SETTLED', attempts: 2 });
  });

  it('bounds retries when Paystack times out and retains a terminal review record', async () => {
    const fixture = await shop();
    await accept(fixture);
    verify(fixture, {}, { delayMs: 11_000 });
    await prisma.paystackReceipt.updateMany({ where: { reference: fixture.request.reference }, data: { attempts: 5 } });
    await drain(fixture.tenant.id);
    expect(await receipt(fixture)).toMatchObject({ state: 'REVIEW', reason: 'VERIFICATION_UNAVAILABLE', attempts: 6 });
    expect(await drain(fixture.tenant.id)).toBe(0);
    await expectCredit(fixture, 0);
  });

  it('deduplicates simultaneous identical deliveries and distinct events in competing workers', async () => {
    const fixture = await shop();
    verify(fixture);
    await Promise.all([
      ...Array.from({ length: 8 }, () => accept(fixture)),
      ...Array.from({ length: 4 }, (_, i) => accept(fixture, i + 1)),
    ]);
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference } })).toBe(5);
    await Promise.all(Array.from({ length: 5 }, () => drain(fixture.tenant.id)));
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference, state: 'SETTLED' } })).toBe(5);
    await expectCredit(fixture, 1);
  });

  it('rejects one transaction identity presented for a second tenant and request', async () => {
    const first = await shop();
    const other = await shop();
    other.transactionId = first.transactionId;
    verify(first);
    verify(other);
    await accept(first);
    await accept(other);
    await drain(first.tenant.id);
    await drain(other.tenant.id);
    expect(await receipt(other)).toMatchObject({ state: 'REVIEW', reason: 'TRANSACTION_ID_CONFLICT', businessId: other.tenant.id });
    await expectCredit(first, 1);
    await expectCredit(other, 0);
  });

  it.each([
    ['PARTIAL_PAYMENT', { amount: 2400 }],
    ['EXCESS_PAYMENT', { amount: 2600 }],
    ['CURRENCY_MISMATCH', { currency: 'NGN' }],
    ['MERCHANT_MISMATCH', { subaccount: { subaccount_code: 'ACCT_wrong' } }],
    ['MERCHANT_UNPROVEN', { subaccount: {} }],
    ['REFERENCE_MISMATCH', { reference: 'fdpay-different' }],
    ['CALLBACK_TRANSACTION_MISMATCH', { id: '1' }],
    ['VERIFICATION_AMBIGUOUS', { id: null }],
    ['PROVIDER_MODE_MISMATCH', { domain: 'live' }],
    ['PROVIDER_REVERSED', { status: 'reversed' }],
    ['PAYMENT_TIME_UNPROVEN', { paid_at: null }],
    ['VERIFIED_RELATIONSHIP_MISMATCH', { metadata: { flowdeskCustomerId: 'different-customer' } }],
    ['VERIFIED_RELATIONSHIP_MISMATCH', { metadata: { flowdeskOrderId: 'different-order' } }],
    ['VERIFIED_RELATIONSHIP_MISMATCH', { metadata: { flowdeskBusinessId: 'different-tenant' } }],
  ] as const)('preserves evidence and avoids allocation for %s', async (reason, overrides) => {
    const fixture = await shop();
    verify(fixture, overrides);
    await accept(fixture);
    await drain(fixture.tenant.id);
    expect(await receipt(fixture)).toMatchObject({ state: 'REVIEW', reason, evidence: expect.any(Object) });
    await expectCredit(fixture, 0);
  });

  it('retains an unknown reference without deriving tenant ownership from provider metadata', async () => {
    const fixture = await shop();
    await prisma.paymentRequest.delete({ where: { id: fixture.request.id } });
    verify(fixture);
    await accept(fixture);
    await drain();
    expect(await receipt(fixture)).toMatchObject({ state: 'REVIEW', reason: 'UNKNOWN_REFERENCE', businessId: null });
    expect(await prisma.payment.count({ where: { businessId: fixture.tenant.id } })).toBe(0);
  });

  it.each(['CANCELLED', 'EXPIRED', 'TIMELY_EXPIRED'] as const)('handles %s without ignoring verified payment time', async (status) => {
    const fixture = await shop();
    const paidAt = new Date(Date.now() - 120_000);
    await prisma.paymentRequest.update({
      where: { id: fixture.request.id },
      data: {
        status: status === 'TIMELY_EXPIRED' ? 'EXPIRED' : status,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    verify(fixture, status === 'TIMELY_EXPIRED' ? { paid_at: paidAt.toISOString() } : {});
    await accept(fixture);
    await drain(fixture.tenant.id);
    if (status === 'TIMELY_EXPIRED') await expectCredit(fixture, 1);
    else {
      expect(await receipt(fixture)).toMatchObject({ state: 'REVIEW', reason: status === 'CANCELLED' ? 'REQUEST_CANCELLED' : 'LATE_PAYMENT' });
      await expectCredit(fixture, 0);
    }
  });

  it('keeps a voided settlement in review on a new event and refuses an unlinked conflicting ledger', async () => {
    const fixture = await shop();
    verify(fixture);
    await accept(fixture);
    await drain(fixture.tenant.id);
    const request = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: fixture.request.id } });
    await ledger.voidPayment(request.paymentId!, fixture.tenant.id, null, 'Fixture correction');
    await accept(fixture, 2);
    await drain(fixture.tenant.id);
    expect(await prisma.paystackReceipt.findFirst({ where: { reference: fixture.request.reference, state: 'REVIEW' } }))
      .toMatchObject({ reason: 'VOIDED_LEDGER' });
    expect(await prisma.payment.count({ where: { businessId: fixture.tenant.id } })).toBe(1);

    const conflict = await shop();
    await ledger.logPayment({
      customerId: conflict.customer.id, amount: 10, method: 'CASH', direction: 'IN',
      attested: true, reference: conflict.request.reference,
    }, conflict.tenant.id, null);
    verify(conflict);
    await accept(conflict);
    await drain(conflict.tenant.id);
    expect(await receipt(conflict)).toMatchObject({ state: 'REVIEW', reason: 'UNLINKED_LEDGER' });
    expect(await prisma.payment.count({ where: { businessId: conflict.tenant.id } })).toBe(1);
    expect(await prisma.paystackSettlement.count({ where: { requestId: conflict.request.id } })).toBe(0);
  });

  it('holds a half-settled legacy request and a receipt pinned to a different tenant', async () => {
    const first = await shop();
    const other = await shop();
    await prisma.paymentRequest.update({ where: { id: first.request.id }, data: { status: 'PAID' } });
    verify(first);
    await accept(first);
    await drain(first.tenant.id);
    expect(await receipt(first)).toMatchObject({ state: 'REVIEW', reason: 'INCOMPLETE_LEGACY_SETTLEMENT' });
    await expectCredit(first, 0);
    await accept(other);
    const pinned = await receipt(other);
    await prisma.paystackReceipt.update({ where: { id: pinned.id }, data: { businessId: first.tenant.id } });
    await drain(first.tenant.id);
    expect(await receipt(other)).toMatchObject({ state: 'REVIEW', reason: 'TENANT_CONFLICT' });
    expect(verificationCalls.get(other.request.reference)).toBeUndefined();
    await expectCredit(other, 0);
  });

  it('rolls back request, ledger and totals on a failed settlement write, then recovers once', async () => {
    const fixture = await shop();
    verify(fixture);
    await accept(fixture);
    await prisma.$executeRawUnsafe(`ALTER TABLE paystack_settlements ADD CONSTRAINT fixture_settlement_failure CHECK ("notificationState" <> 'PENDING') NOT VALID`);
    try {
      await drain(fixture.tenant.id);
      await expectCredit(fixture, 0);
      expect(await receipt(fixture)).toMatchObject({ state: 'WAITING', reason: 'LOCAL_WRITE_FAILED', evidence: { amountMinor: 2500 } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE paystack_settlements DROP CONSTRAINT fixture_settlement_failure');
    }
    await due(fixture);
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
  });

  it('recovers an accepted receipt when the database stops accepting connections', async () => {
    const fixture = await shop();
    verify(fixture);
    await accept(fixture);
    const url = new URL(dbUrl!);
    const name = url.pathname.slice(1);
    expect(name).toBe('flowdesk_g1_empty');
    url.pathname = '/postgres';
    const admin = new PrismaClient({ datasourceUrl: url.toString() });
    await prisma.$disconnect();
    try {
      await admin.$executeRawUnsafe('ALTER DATABASE "flowdesk_g1_empty" WITH ALLOW_CONNECTIONS false');
      await expect(claim(fixture.tenant.id)).rejects.toThrow();
    } finally {
      await admin.$executeRawUnsafe('ALTER DATABASE "flowdesk_g1_empty" WITH ALLOW_CONNECTIONS true');
      await admin.$disconnect();
      await prisma.$disconnect();
      await prisma.$connect();
    }
    expect(await receipt(fixture)).toMatchObject({ state: 'PENDING' });
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
  });

  it('settles during a Redis connection loss and retains notification work for recovery', async () => {
    const fixture = await shop();
    await prisma.business.update({ where: { id: fixture.tenant.id }, data: { receiptsEnabled: true } });
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { lastInboundAt: new Date() } });
    verify(fixture);
    redis.disconnect();
    try {
      await accept(fixture);
      await drain(fixture.tenant.id);
      await drainNotifications();
      await expectCredit(fixture, 1);
      expect(await prisma.paystackSettlement.findUnique({ where: { requestId: fixture.request.id } }))
        .toMatchObject({ notificationState: 'PENDING', notificationAttempts: 0 });
    } finally {
      await redis.connect();
      await redis.ping();
    }
    await vi.waitFor(async () => {
      await drainNotifications();
      const result = await prisma.paystackSettlement.findUniqueOrThrow({ where: { requestId: fixture.request.id } });
      expect(result.notificationState).toBe('HANDED_OFF');
    }, { timeout: 8_000, interval: 100 });
    const settlement = await prisma.paystackSettlement.findUniqueOrThrow({ where: { requestId: fixture.request.id } });
    const job = await outboundQueue.getJob(`receipt-${settlement.paymentId}`);
    expect(job?.data).toMatchObject({ businessId: fixture.tenant.id, customerId: fixture.customer.id });
  });

  it('preserves ambiguous initialization and prevents another equivalent provider action', async () => {
    const fixture = await shop();
    await prisma.paymentRequest.delete({ where: { id: fixture.request.id } });
    const input = { customerId: fixture.customer.id, orderId: fixture.order!.id, amount: 25, send: false };
    const before = initializationCalls.length;
    failInitialization = true;
    try {
      await expect(links.createPaymentLink(fixture.tenant.id, input, null)).rejects.toThrow();
    } finally {
      failInitialization = false;
    }
    const intent = await prisma.paystackInitialization.findFirstOrThrow({ where: { businessId: fixture.tenant.id } });
    expect(intent).toMatchObject({ state: 'REVIEW', reason: 'INITIALIZATION_UNCONFIRMED', requestId: null });
    await expect(links.createPaymentLink(fixture.tenant.id, input, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(initializationCalls).toHaveLength(before + 1);
    fixture.request.reference = intent.reference;
    verify(fixture);
    await accept(fixture);
    await drain(fixture.tenant.id);
    expect(await receipt(fixture)).toMatchObject({ state: 'REVIEW', reason: 'INITIALIZATION_UNLINKED', evidence: { amountMinor: 2500 } });
    expect(await prisma.payment.count({ where: { businessId: fixture.tenant.id } })).toBe(0);
  });

  function childFor(phase: string, fixture: Fixture) {
    return fork(fileURLToPath(new URL('./fixtures/paystack-crash.ts', import.meta.url)), [phase, fixture.tenant.id, origin], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
  }

  async function expireLease(fixture: Fixture) {
    await prisma.paystackReceipt.updateMany({
      where: { reference: fixture.request.reference, state: 'PROCESSING' }, data: { leaseUntil: new Date(0) },
    });
  }

  it.each([['before-verify', 'claimed'], ['after-commit', 'SETTLED']] as const)(
    'recovers after a real process interruption %s', async (phase, message) => {
      const fixture = await shop();
      verify(fixture);
      await accept(fixture);
      const child = childFor(phase, fixture);
      const exited = once(child, 'exit');
      try {
        const signal = await Promise.race([
          once(child, 'message', { signal: AbortSignal.timeout(45_000) }).then(([value]) => value),
          exited.then(([code]) => { throw new Error(`Child exited early: ${code}`); }),
        ]);
        expect(signal).toBe(message);
        if (phase === 'before-verify') expect(verificationCalls.get(fixture.request.reference)).toBeUndefined();
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      await expireLease(fixture);
      await accept(fixture);
      await drain(fixture.tenant.id);
      await expectCredit(fixture, 1);
      expect(await receipt(fixture)).toMatchObject({ state: 'SETTLED' });
    }, 60_000,
  );

  it('kills a process blocked inside the real financial transaction after durable verification evidence', async () => {
    const fixture = await shop();
    verify(fixture);
    await accept(fixture);
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fixture_paystack_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         PERFORM pg_advisory_xact_lock(700103); RETURN NEW; END; $$`,
    );
    await prisma.$executeRawUnsafe('CREATE TRIGGER fixture_paystack_pause BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fixture_paystack_pause()');
    let unblock!: () => void;
    let locked!: (pid: number) => void;
    const block = new Promise<void>((resolve) => { unblock = resolve; });
    const ready = new Promise<number>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(700103)`;
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked(pid);
      await block;
    }, { timeout: 55_000 });
    const pid = await ready;
    const child = childFor('during-commit', fixture);
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(async () => {
        const [{ blocked }] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%insert%payments%') AS blocked
        `;
        expect(blocked).toBe(true);
      }, { timeout: 42_000, interval: 100 });
      expect(await receipt(fixture)).toMatchObject({ state: 'PROCESSING', evidence: { amountMinor: 2500 } });
      await expectCredit(fixture, 0);
    } finally {
      child.kill('SIGKILL');
      await exited;
      unblock();
      await holder;
      await prisma.$executeRawUnsafe('DROP TRIGGER fixture_paystack_pause ON payments');
      await prisma.$executeRawUnsafe('DROP FUNCTION fixture_paystack_pause()');
    }
    await expectCredit(fixture, 0);
    await expireLease(fixture);
    await drain(fixture.tenant.id);
    await expectCredit(fixture, 1);
  }, 65_000);

  it('preserves legacy paid links and half-settled rows on the synthetic upgrade', async () => {
    const upgraded = new PrismaClient({ datasourceUrl: upgradeUrl! });
    try {
      expect(await upgraded.paymentRequest.findUnique({ where: { id: 'g104-legacy-request' } })).toMatchObject({
        status: 'PAID', paymentId: 'g104-legacy-credit',
      });
      expect(await upgraded.paymentRequest.findUnique({ where: { id: 'g103-legacy-half' } })).toMatchObject({
        status: 'PAID', paymentId: null,
      });
      expect(await upgraded.payment.findUnique({ where: { id: 'g103-legacy-unlinked' } })).toMatchObject({
        reference: 'fdpay-legacy-half', orderId: 'g103-legacy-order',
      });
      expect(await upgraded.paystackSettlement.count()).toBe(0);
      expect(await upgraded.paystackReceipt.count()).toBe(0);
    } finally {
      await upgraded.$disconnect();
    }
  });
});
