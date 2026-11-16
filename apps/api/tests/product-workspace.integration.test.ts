import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PrismaClient, StaffRole } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;
const fixtures = database || cache ? describe : describe.skip;

fixtures('Batch 5 product workspace on PostgreSQL and Redis', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let closeRedis: () => void;
  let closeOutbound: () => Promise<void>;

  beforeAll(async () => {
    if (![database, cache].every((value) => value && new URL(value).hostname === '127.0.0.1' && new URL(value).port) ||
        !new URL(database!).pathname.startsWith('/flowdesk_g1_') || new URL(cache!).port === '6379') {
      throw new Error('Use disposable loopback PostgreSQL and Redis');
    }
    process.env.DATABASE_URL = database;
    process.env.REDIS_URL = cache!;
    ({ prisma } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    const redisConfig = await import('../src/config/redis.js');
    closeRedis = () => [redisConfig.redis, redisConfig.redisSubscriber, redisConfig.sseSubscriber, redisConfig.rateLimitRedis]
      .forEach((client) => client.disconnect());
    await redisConfig.connectRedis();
    const { outboundMessagesQueue } = await import('../src/queues/outbound.queue.js');
    closeOutbound = () => outboundMessagesQueue.close();
    app = await (await import('../src/app.js')).createApp();
  }, 60_000);

  afterAll(async () => {
    try {
      await closeOutbound?.();
      await app?.close();
      await prisma?.$disconnect();
    } finally { closeRedis?.(); }
  });

  async function tenant() {
    const business = await prisma.business.create({ data: { name: 'Local fixture company', ownerName: 'Fixture owner',
      waPhoneNumberId: randomUUID(), waAccessToken: 'synthetic-fixture-token' } });
    const businessId = business.id;
    const customer = await prisma.customer.create({ data: { businessId, waNumber: '233209010001', name: 'Fixture customer', lastInboundAt: new Date() } });
    const staff = (role: StaffRole, suffix: number) => prisma.staff.create({ data: { businessId, role, name: `Fixture ${role}`,
      phone: `23320901100${suffix}`, inviteAcceptedAt: new Date() } });
    const api = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: Record<string, unknown>, actor?: { id: string; role: StaffRole }) =>
      app.inject({ method, url: '/api/v1' + path, ...(payload ? { payload } : {}), headers: { authorization: 'Bearer ' +
        sign({ businessId, plan: 'BUSINESS', ...(actor ? { staffId: actor.id, role: actor.role } : {}) }, '15m') } });
    return { businessId, customer, staff, api };
  }

  function data(response: { statusCode: number; body: string; json: () => { data: any } }, status = 200) {
    expect(response.statusCode, response.body).toBe(status);
    return response.json().data;
  }

  it('persists profile, distinguishes addresses from provider evidence, and rejects stale and staff writes', async () => {
    const f = await tenant();
    const manager = await f.staff('MANAGER', 1);
    const before = data(await f.api('GET', '/onboarding'));
    expect(before).toMatchObject({ profile: null, profileRevision: 0, ready: false, providers: { whatsapp: 'VERIFICATION_PENDING' } });
    const request = { profile: 'APPOINTMENT', revision: 0 };
    expect((await f.api('PUT', '/onboarding/profile', request, manager)).statusCode).toBe(403);
    expect(data(await f.api('PUT', '/onboarding/profile', request))).toMatchObject({ profile: 'APPOINTMENT', profileRevision: 1, ready: false });
    expect((await f.api('PUT', '/onboarding/profile', { ...request, profile: 'ONLINE_RETAIL' })).statusCode).toBe(409);
    expect(data(await f.api('GET', '/onboarding')).steps).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hours', blocking: true, done: false })]));
    expect(await prisma.workflowSettings.findUnique({ where: { businessId: f.businessId } })).toMatchObject({ enabled: false, supportMode: 'OWNER_REVIEW' });
  });

  it('scopes operational counts and context to the tenant, role and delivery assignment', async () => {
    const f = await tenant();
    const other = await tenant();
    const [rider, otherRider, operator] = await Promise.all([f.staff('DELIVERY', 1), f.staff('DELIVERY', 2), f.staff('OPERATIONS', 3)]);
    const order = (businessId: string, customerId: string, referenceNumber: string, assignedStaffId?: string) =>
      ({ businessId, customerId, referenceNumber, rawMessage: 'Scoped fixture', assignedStaffId });
    await prisma.order.createMany({ data: [order(f.businessId, f.customer.id, 'FD-1', rider.id),
      order(f.businessId, f.customer.id, 'FD-2', otherRider.id), order(other.businessId, other.customer.id, 'FD-1')] });
    const owner = data(await f.api('GET', '/dashboard/overview?days=30'));
    expect(owner).toMatchObject({ orders: { received: 2, pending: 2 }, money: { verifiedReceipts: '0.00', outstandingInvoices: '0.00' } });
    expect(data(await f.api('GET', '/dashboard/overview', undefined, rider))).toMatchObject({
      orders: { received: 1, pending: 1 }, money: null, visits: null, care: null, decisions: null,
    });
    expect(data(await f.api('GET', '/dashboard/overview', undefined, operator)).money).toBeNull();
    const context = `/conversations/${f.customer.id}/context`;
    expect(data(await f.api('GET', context)).orders).toHaveLength(2);
    expect((await f.api('GET', context, undefined, rider)).statusCode).toBe(403);
    expect((await other.api('GET', context)).statusCode).toBe(404);
  });

  it('creates one invoice after concurrent retries, preserves account identity, and validates outstanding amounts', async () => {
    const f = await tenant();
    const other = await tenant();
    const input = { customerId: f.customer.id, requestKey: randomUUID(), dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      lines: [{ description: 'Fixture price', quantity: 2, unitMinor: 325 }] };
    const results = await Promise.all(Array.from({ length: 4 }, () => f.api('POST', '/commerce/invoices', input)));
    const invoices = results.map((result) => data(result, 201));
    expect(new Set(invoices.map(({ id }) => id)).size).toBe(1);
    const path = '/commerce/invoices/' + invoices[0].id;
    const draftPath = '/commerce/invoices/drafts/' + input.requestKey;
    expect(await prisma.commerceInvoice.count({ where: { businessId: f.businessId } })).toBe(1);
    expect((await f.api('POST', '/commerce/invoices', { ...input, terms: 'Different obligation' })).statusCode).toBe(409);
    expect((await other.api('POST', '/commerce/invoices', input)).statusCode).toBe(404);
    expect((await other.api('GET', path)).statusCode).toBe(404);
    expect(data(await other.api('GET', draftPath))).toBeNull();
    expect(data(await f.api('GET', draftPath))).toMatchObject({ id: invoices[0].id });
    const ownInvoice = data(await other.api('POST', '/commerce/invoices', { ...input, customerId: other.customer.id }), 201);
    expect(ownInvoice.id).not.toBe(invoices[0].id);
    data(await f.api('POST', `${path}/decision`, { action: 'ISSUE' }));
    expect(data(await f.api('GET', path)).scopeKind).toBe('STANDALONE');
    expect(data(await f.api('GET', '/dashboard/overview')).money).toEqual({ verifiedReceipts: '0.00', outstandingInvoices: '6.50', openInvoices: 1 });
    expect(data(await other.api('GET', '/dashboard/overview')).money.openInvoices).toBe(0);
  });

  it('recovers the one saved manual order by request identity and rejects mismatched or foreign replays', async () => {
    const f = await tenant();
    const other = await tenant();
    const rider = await f.staff('DELIVERY', 1);
    const key = randomUUID();
    const payload = { requestKey: key, customerId: f.customer.id, rawMessage: 'Fixture manual order',
      items: [{ description: 'Fixture item', quantity: 2, unitPrice: 3.50 }] };
    const results = await Promise.all(Array.from({ length: 4 }, () => f.api('POST', '/orders', payload)));
    const ids = results.map((result) => data(result, 201).id);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.order.count({ where: { businessId: f.businessId } })).toBe(1);
    const lookup = '/orders/manual/' + key;
    expect(data(await f.api('GET', lookup))).toEqual({ id: ids[0] });
    expect(data(await other.api('GET', lookup))).toBeNull();
    expect((await f.api('GET', lookup, undefined, rider)).statusCode).toBe(403);
    expect((await f.api('POST', '/orders', { ...payload, notes: 'Changed' })).statusCode).toBe(409);
    expect((await other.api('POST', '/orders', payload)).statusCode).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ids[0] } })).totalAmount.toFixed(2)).toBe('7.00');
  });

  it('measures scoped aggregate and thread reads over synthetic operating volumes', async () => {
    const f = await tenant();
    const { businessId, customer } = f;
    const service = await prisma.service.create({ data: { businessId, name: 'Fixture visit', durationMinutes: 10 } });
    const now = Date.now() + 60_000;
    await Promise.all([
      prisma.order.createMany({ data: Array.from({ length: 480 }, (_, i) => ({ businessId, customerId: customer.id,
        referenceNumber: `FD-${i}`, rawMessage: 'Synthetic order' })) }),
      prisma.appointment.createMany({ data: Array.from({ length: 360 }, (_, i) => ({ businessId, customerId: customer.id,
        serviceId: service.id, reference: `AP-${i}`, startsAt: new Date(now + i * 900_000), endsAt: new Date(now + i * 900_000 + 600_000),
        blockedUntil: new Date(now + i * 900_000 + 600_000) })) }),
      prisma.message.createMany({ data: Array.from({ length: 2_400 }, (_, i) => ({ businessId, customerId: customer.id,
        waMessageId: `${businessId}-${i}`, direction: 'INBOUND' as const, body: `Synthetic message ${i}` })) }),
      prisma.customer.createMany({ data: Array.from({ length: 1_000 }, (_, i) => ({ businessId,
        waNumber: `2332072${String(i).padStart(5, '0')}`, name: `Synthetic customer ${i}` })) }),
    ]);
    const started = performance.now();
    const overview = data(await f.api('GET', '/dashboard/overview?days=30'));
    const overviewMs = performance.now() - started;
    const threadStarted = performance.now();
    const thread = data(await f.api('GET', `/conversations/${customer.id}`));
    const threadMs = performance.now() - threadStarted;
    const reportStart = performance.now();
    const report = data(await f.api('GET', '/reports?days=90'));
    const reportMs = performance.now() - reportStart;
    const exportStart = performance.now();
    const exported = await f.api('GET', '/reports/export.csv?days=90');
    const exportMs = performance.now() - exportStart;
    const searchStart = performance.now();
    const [firstPage, secondPage] = await Promise.all([
      f.api('GET', '/customers?search=Synthetic&page=1&pageSize=25'),
      f.api('GET', '/customers?search=Synthetic&page=2&pageSize=25'),
    ]);
    const searchMs = performance.now() - searchStart;
    const firstIds = new Set(data(firstPage).map((row: { id: string }) => row.id));
    expect(firstIds.size).toBe(25);
    expect(data(secondPage).filter((row: { id: string }) => firstIds.has(row.id))).toHaveLength(0);
    expect(report.orders).toBe(480);
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('"Total",0.00,480');
    expect(overview.orders.pending).toBe(480);
    expect(overview.visits.upcoming).toBe(360);
    expect(thread.messages).toHaveLength(200);
    const previous = data(await f.api('GET', `/conversations/${customer.id}?before=${thread.nextBefore}`));
    expect(previous.messages).toHaveLength(200);
    const seen = new Set(thread.messages.map(({ id }: { id: string }) => id));
    expect(previous.messages.some(({ id }: { id: string }) => seen.has(id))).toBe(false);
    const other = await tenant();
    expect((await other.api('GET', `/conversations/${other.customer.id}?before=${thread.nextBefore}`)).statusCode).toBe(404);
    console.info(`Batch 5 fixture timings overview=${overviewMs.toFixed(1)}ms thread=${threadMs.toFixed(1)}ms ` +
      `report=${reportMs.toFixed(1)}ms csv=${exportMs.toFixed(1)}ms concurrentSearch=${searchMs.toFixed(1)}ms`);
  }, 30_000);
});
