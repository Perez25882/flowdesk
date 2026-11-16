import { randomUUID } from 'node:crypto';
import type { PrismaClient, StaffRole } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;

(database || cache ? describe : describe.skip)('Conversation ownership with PostgreSQL and authenticated Fastify routes', () => {
  let db: PrismaClient;
  let app: FastifyInstance;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let closeRedis: () => void;
  let closeOutbound: () => Promise<void>;

  beforeAll(async () => {
    if (![database, cache].every((value) => value && new URL(value).hostname === '127.0.0.1' && new URL(value).port) ||
        !new URL(database!).pathname.startsWith('/flowdesk_g1_') || new URL(cache!).port === '6379') throw new Error('Use disposable IPv4 fixtures');
    process.env.DATABASE_URL = database;
    process.env.REDIS_URL = cache;
    ({ prisma: db } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    const connections = await import('../src/config/redis.js');
    closeRedis = () => [connections.redis, connections.redisSubscriber, connections.rateLimitRedis, connections.sseSubscriber].forEach((client) => client.disconnect());
    await connections.connectRedis();
    const queue = await import('../src/queues/outbound.queue.js');
    closeOutbound = () => queue.outboundMessagesQueue.close();
    app = await (await import('../src/app.js')).createApp();
  }, 60_000);

  afterAll(async () => {
    try { await closeOutbound?.(); await app?.close(); await db?.$disconnect(); } finally { closeRedis?.(); }
  });

  async function fixture() {
    const businessId = (await db.business.create({ data: { name: 'Inbox fixture', ownerName: 'Fixture owner',
      waPhoneNumberId: randomUUID(), waAccessToken: 'synthetic-fixture-only' } })).id;
    const customerId = (await db.customer.create({ data: { businessId, name: 'Inbox customer', waNumber: '233202000001', lastInboundAt: new Date() } })).id;
    const message = await db.message.create({ data: { businessId, customerId, direction: 'INBOUND', body: 'Test inquiry',
      waMessageId: randomUUID(), requiresReview: true } });
    const staff = (role: StaffRole, digit: number) => db.staff.create({ data: { businessId, role, name: `${role} ${digit}`,
      phone: `23320742000${digit}`, inviteAcceptedAt: new Date() } });
    const api = (method: 'GET' | 'PUT' | 'POST', path: string, payload?: Record<string, unknown>, actor?: { id: string; role: StaffRole }) =>
      app.inject({ method, url: '/api/v1' + path, ...(payload ? { payload } : {}), headers: { authorization: 'Bearer ' +
        sign({ businessId, plan: 'BUSINESS', ...(actor ? { staffId: actor.id, role: actor.role } : {}) }, '15m') } });
    const path = `/conversations/${customerId}`;
    const assign = (staffId: string | null, revision: number, actor?: { id: string; role: StaffRole }) =>
      api('PUT', path + '/assignment', { staffId, revision }, actor);
    const read = (through: string | null, revision: number, actor?: { id: string; role: StaffRole }) =>
      api('PUT', path + '/read-state', { through, revision }, actor);
    return { businessId, customerId, staff, api, path, assign, read, message };
  }

  function data(response: { statusCode: number; body: string; json: () => { data: any } }, status = 200) {
    expect(response.statusCode, response.body).toBe(status);
    return response.json().data;
  }

  it('assigns, reassigns, releases and preserves identity and exact audit revisions', async () => {
    const f = await fixture();
    const [manager, first, second] = await Promise.all([f.staff('MANAGER', 1), f.staff('OPERATIONS', 2), f.staff('OPERATIONS', 3)]);
    expect(data(await f.assign(first.id, 0))).toMatchObject({ assignee: { id: first.id }, revision: 1 });
    expect(data(await f.assign(second.id, 1, manager))).toMatchObject({ assignee: { id: second.id }, revision: 2 });
    expect((await f.assign(manager.id, 1)).statusCode).toBe(409);
    expect(data(await f.assign(second.id, 1, manager)).revision).toBe(2);
    expect(data(await f.assign(null, 2, second))).toMatchObject({ assignee: null, revision: 3 });
    const history = data(await f.api('GET', f.path + '/assignment-history'));
    expect(history).toMatchObject([{ revision: 3, actorStaffId: second.id, previousStaffId: second.id, assignedStaffId: null },
      { revision: 2, actorStaffId: manager.id, previousStaffId: first.id, assignedStaffId: second.id },
      { revision: 1, actorStaffId: null, previousStaffId: null, assignedStaffId: first.id }]);
    expect(data(await f.api('GET', f.path)).messages[0].id).toBe(f.message.id);
  });

  it('allows exactly one concurrent claim and rejects foreign, unaccepted, delivery and stale-role writes', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const [first, second, rider, outsider] = await Promise.all([f.staff('OPERATIONS', 1), f.staff('OPERATIONS', 2), f.staff('DELIVERY', 3), foreign.staff('OPERATIONS', 1)]);
    expect((await f.assign(outsider.id, 0)).statusCode).toBe(404);
    expect((await f.assign(rider.id, 0)).statusCode).toBe(404);
    expect((await f.assign(rider.id, 0, rider)).statusCode).toBe(403);
    expect((await f.api('GET', f.path, undefined, rider)).statusCode).toBe(403);
    expect((await foreign.api('GET', f.path)).statusCode).toBe(404);
    expect((await foreign.api('PUT', f.path + '/read-state', { through: '1', revision: 0 })).statusCode).toBe(404);
    expect((await foreign.api('PUT', f.path + '/assignment', { staffId: outsider.id, revision: 0 })).statusCode).toBe(404);
    const statuses = await Promise.all([f.assign(first.id, 0, first), f.assign(second.id, 0, second)]);
    expect(statuses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = statuses[0]?.statusCode === 200 ? first : second;
    expect(data(await f.api('GET', '/conversations?assignment=mine', undefined, winner)).conversations).toHaveLength(1);
    expect(data(await f.api('GET', '/conversations?assignment=unassigned')).conversations).toHaveLength(0);
    await db.staff.update({ where: { id: winner.id }, data: { active: false } });
    expect((await f.assign(null, 1, winner)).statusCode).toBe(403);
    expect(data(await f.api('GET', '/conversations?assignment=unassigned')).conversations).toHaveLength(1);
    expect(data(await f.api('GET', f.path + '/assignment-history'))).toHaveLength(1);
  });

  it('rechecks a target staff member who is removed while assignment is waiting for their row', async () => {
    const f = await fixture();
    const target = await f.staff('OPERATIONS', 1);
    let assignment: ReturnType<typeof f.assign> | undefined;
    await db.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: target.id }, data: { active: false } });
      assignment = Promise.resolve(f.assign(target.id, 0));
      await expect.poll(async () => {
        const [lock] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FROM staff%' AND query LIKE '%FOR SHARE%') AS waiting`;
        return lock?.waiting;
      }, { timeout: 5000 }).toBe(true);
    }, { timeout: 10_000 });
    expect((await assignment)?.statusCode).toBe(404);
    expect(data(await f.api('GET', f.path)).inbox.revision).toBe(0);
  });

  it('counts old-timestamp arrival once, isolates readers, and fences a newer manual unread action', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([f.staff('OPERATIONS', 1), f.staff('OPERATIONS', 2)]);
    expect(data(await f.api('GET', f.path, undefined, first)).inbox).toMatchObject({ unread: 1, inboundPosition: '1' });
    expect(data(await f.read('1', 0, first))).toMatchObject({ unread: 0, readPosition: '1', readRevision: 1 });
    expect(data(await f.read('1', 0, first)).readRevision).toBe(1);
    expect(data(await f.api('GET', f.path, undefined, second)).inbox.unread).toBe(1);
    expect(data(await f.assign(second.id, 0)).unread).toBe(1);
    await db.message.createMany({ data: [{ businessId: f.businessId, customerId: f.customerId, direction: 'INBOUND',
      waMessageId: f.message.waMessageId }], skipDuplicates: true });
    expect(data(await f.api('GET', f.path, undefined, first)).inbox.unread).toBe(0);
    await db.message.create({ data: { businessId: f.businessId, customerId: f.customerId, direction: 'INBOUND',
      waMessageId: randomUUID(), createdAt: new Date(0) } });
    expect(data(await f.api('GET', '/dashboard/badges', undefined, first)).unreadConversations).toBe(1);
    expect(data(await f.api('GET', '/conversations?filter=unread', undefined, first)).conversations).toHaveLength(1);
    expect(data(await f.read('1', 1, first)).unread).toBe(1);
    expect(data(await f.read('2', 1, first))).toMatchObject({ unread: 0, readPosition: '2', readRevision: 2 });
    expect(data(await f.read(null, 2, first))).toMatchObject({ manuallyUnread: true, readPosition: '2', readRevision: 3 });
    expect((await f.read('1', 2, first)).statusCode).toBe(409);
    expect((await f.read('77', 3, first)).statusCode).toBe(400);
    expect(data(await f.read('2', 3, first))).toMatchObject({ unread: 0, manuallyUnread: false });
    expect(data(await f.api('GET', f.path, undefined, second)).inbox.unread).toBe(2);
  });

  it('pages tied and missing activity timestamps without omitting threads', async () => {
    const f = await fixture();
    const time = new Date(123_000);
    for (const [index, lastInteractionAt] of [time, time, null, null].entries()) {
      const { id } = await db.customer.create({ data: { businessId: f.businessId, waNumber: `23320550000${index}`, lastInteractionAt } });
      await db.message.create({ data: { businessId: f.businessId, customerId: id, waMessageId: randomUUID(), direction: 'INBOUND' } });
    }
    let cursor = '';
    const seen: string[] = [];
    for (let page = 0; page < 5; page++) {
      const result = data(await f.api('GET', '/conversations?limit=1' + (cursor ? '&cursor=' + cursor : '')));
      seen.push(result.conversations[0].customerId);
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  it('keeps unanswered work distinct from individual unread state and links scoped support cases', async () => {
    const f = await fixture();
    const outsider = await fixture();
    expect(data(await f.api('GET', '/conversations?filter=needs_you')).conversations).toHaveLength(1);
    await f.read('1', 0);
    expect(data(await f.api('GET', '/dashboard/badges'))).toMatchObject({ reviewMessages: 1, unreadConversations: 0 });
    const support = await db.commerceCase.create({ data: { businessId: f.businessId, customerId: f.customerId, sourceId: f.message.id, kind: 'COMPLAINT' } });
    expect(data(await f.api('GET', f.path + '/context')).cases[0].id).toBe(support.id);
    expect((await outsider.api('GET', f.path + '/context')).statusCode).toBe(404);
    await db.message.create({ data: { businessId: f.businessId, customerId: f.customerId, direction: 'OUTBOUND',
      waMessageId: randomUUID(), createdAt: f.message.createdAt } });
    expect(data(await f.api('GET', '/conversations?filter=needs_you')).conversations).toHaveLength(0);
    expect(data(await f.api('GET', '/dashboard/badges'))).toMatchObject({ reviewMessages: 0, unreadConversations: 0 });
  });

  it('allows the assigned operator to authorize a single human reply', async () => {
    const f = await fixture();
    const operator = await f.staff('OPERATIONS', 1);
    data(await f.assign(operator.id, 0));
    const path = '/messages/' + f.message.id + '/reply';
    const reply = { source: 'human', body: 'Your request has reached our team.' };
    data(await f.api('POST', path, reply, operator));
    data(await f.api('POST', path, reply, operator));
    const sends = await db.whatsAppSend.findMany({ where: { businessId: f.businessId } });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toMatchObject({ customerId: f.customerId, sentByStaffId: operator.id, operatorReply: true });
  });

  it('isolates reports, CSV exports and customer search and defuses spreadsheet formulas', async () => {
    const f = await fixture();
    const other = await fixture();
    const [manager, operator] = await Promise.all([f.staff('MANAGER', 1), f.staff('OPERATIONS', 2)]);
    await db.customer.update({ where: { id: other.customerId }, data: { name: 'Foreign-only search marker' } });
    for (const [scope, name, value] of [[f, '  =2+2', 11], [other, 'Foreign-only catalogue marker', 79]] as const) {
      await db.order.create({ data: { businessId: scope.businessId, customerId: scope.customerId, referenceNumber: 'FD-REPORT',
        rawMessage: 'Report seed', totalAmount: value, status: 'FULFILLED', items: { create: {
          description: name, quantity: 1, unitPrice: value, subtotal: value,
        } } } });
      await db.payment.createMany({ data: [{ businessId: scope.businessId, customerId: scope.customerId, amount: value, method: 'CASH',
        direction: 'IN', confidence: 'SELLER_ATTESTED' }, { businessId: scope.businessId, customerId: scope.customerId, amount: 200,
        method: 'CASH', direction: 'IN', confidence: 'CLAIMED' }] });
    }
    expect(data(await f.api('GET', '/reports?days=60', undefined, manager))).toMatchObject({ days: 60, revenue: 11, orders: 1 });
    expect(data(await other.api('GET', '/reports?days=90'))).toMatchObject({ days: 90, revenue: 79, orders: 1 });
    const csv = await f.api('GET', '/reports/export.csv?days=30', undefined, manager);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(`"'  =2+2",1,11.00`);
    expect(csv.body).not.toContain('Foreign-only');
    expect(csv.body).not.toContain('233202000001');
    expect((await f.api('GET', '/reports/export.csv', undefined, operator)).statusCode).toBe(403);
    expect(data(await f.api('GET', '/customers?search=Foreign-only'))).toHaveLength(0);
    expect((await f.api('GET', '/customers/' + other.customerId)).statusCode).toBe(404);
    await db.staff.update({ where: { id: manager.id }, data: { role: 'OPERATIONS' } });
    expect((await f.api('GET', '/reports?days=30', undefined, manager)).statusCode).toBe(403);
  });

  it('paginates tied workflow timestamps and refuses a foreign page anchor', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const fixed = new Date(60_000);
    const makeWorkflow = (scope: typeof f) => ({ businessId: scope.businessId, customerId: scope.customerId, sourceId: randomUUID(),
      correlationKey: randomUUID(), definition: 'whatsapp-business', version: 3, policyRevision: 1,
      operator: 'CARE' as const, state: 'WAITING_OWNER_APPROVAL' as const, reason: 'Scope fixture', createdAt: fixed,
      deadlineAt: new Date(Date.now() + 60_000) });
    await db.workflow.createMany({ data: Array.from({ length: 55 }, () => makeWorkflow(f)) });
    const secondTenant = await db.workflow.create({ data: makeWorkflow(foreign) });
    const first = data(await f.api('GET', '/workflows?state=WAITING_OWNER_APPROVAL'));
    const second = data(await f.api('GET', `/workflows?state=WAITING_OWNER_APPROVAL&afterId=${first.at(-1).id}`));
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(55);
    expect((await f.api('GET', '/workflows?afterId=' + secondTenant.id)).statusCode).toBe(404);
  });
});
