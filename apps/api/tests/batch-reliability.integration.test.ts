import { fork } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const redis = process.env.G1_BATCH_REDIS_URL;
const secret = 'flowdesk-batch-synthetic-whatsapp-secret';

describe.skipIf(!database || !redis)('Batch 1 with disposable PostgreSQL and BullMQ', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof Fastify>;
  let orders: typeof import('../src/modules/orders/orders.service.js');
  let outbound: typeof import('../src/workers/outbound.worker.js');
  let queue: typeof import('../src/queues/outbound.queue.js');
  let close: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (new URL(database!).hostname !== '127.0.0.1' || !new URL(database!).pathname.startsWith('/flowdesk_g1_') ||
        new URL(redis!).hostname !== '127.0.0.1' || new URL(redis!).port === '6379') throw new Error('Use disposable loopback fixtures');
    process.env.DATABASE_URL = database;
    process.env.REDIS_URL = redis;
    process.env.META_WEBHOOK_SECRET = secret;
    process.env.HAIKU_FALLBACK_ENABLED = 'false';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    ({ prisma } = await import('../src/config/database.js'));
    const { disconnectRedis } = await import('../src/config/redis.js');
    orders = await import('../src/modules/orders/orders.service.js');
    outbound = await import('../src/workers/outbound.worker.js');
    queue = await import('../src/queues/outbound.queue.js');
    close = async () => {
      await outbound.outboundWorker.close();
      await queue.outboundMessagesQueue.close();
      await disconnectRedis();
    };
    app = Fastify();
    await app.register(import('fastify-raw-body'), { field: 'rawBody', global: false, encoding: false, runFirst: true });
    await app.register((await import('../src/modules/webhook/webhook.route.js')).default);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
    await prisma?.$disconnect();
    vi.unstubAllGlobals();
  });

  async function shop() {
    const phone = randomUUID();
    const business = await prisma.business.create({ data: {
      name: 'Batch synthetic shop', ownerName: 'Fixture', aiAssistMode: 'OFF',
      waPhoneNumberId: phone, waAccessToken: 'synthetic-batch-token',
    } });
    const customer = await prisma.customer.create({ data: { businessId: business.id, waNumber: '233201234567', lastInboundAt: new Date() } });
    const body = 'I want to buy 2 bags of Rice';
    const source = await prisma.message.create({ data: { businessId: business.id, customerId: customer.id,
      direction: 'INBOUND', waMessageId: randomUUID(), body } });
    await prisma.product.create({ data: { businessId: business.id, name: 'Rice', unit: 'bag', price: 80, stockQuantity: 20 } });
    return { phone, business, customer, source, body };
  }

  it('serializes competing inbound writes and commits full source linkage', async () => {
    const { business, customer, source, body } = await shop();
    const deliver = () => orders.createOrderFromMessage(body, business.id, customer.id, source.id);
    const results = await Promise.all([deliver(), deliver(), deliver()]);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ order }) => order.id)).size).toBe(1);
    expect(results[0]!.order.totalAmount.toNumber()).toBe(160);
    const committed = await prisma.message.findUniqueOrThrow({ where: { id: source.id } });
    expect(committed.relatedOrderId).toBe(results[0]!.order.id);
    expect(await prisma.order.count({ where: { inboundSourceMessageId: source.id } })).toBe(1);
    const foreign = await shop();
    await expect(orders.createOrderFromMessage(body, business.id, foreign.customer.id, source.id)).rejects.toThrow('Customer not found');
  });

  it('rolls back an order when the same transaction cannot link its source, then replays', async () => {
    const { business, customer, source, body } = await shop();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION g1_batch_deny_link() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN IF NEW."relatedOrderId" IS NOT NULL THEN RAISE EXCEPTION 'synthetic link failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER g1_batch_deny_link BEFORE UPDATE OF "relatedOrderId" ON messages FOR EACH ROW EXECUTE FUNCTION g1_batch_deny_link()');
    try {
      await expect(orders.createOrderFromMessage(body, business.id, customer.id, source.id)).rejects.toThrow();
      expect(await prisma.order.count({ where: { businessId: business.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER g1_batch_deny_link ON messages');
      await prisma.$executeRawUnsafe('DROP FUNCTION g1_batch_deny_link()');
    }
    expect((await orders.createOrderFromMessage(body, business.id, customer.id, source.id)).created).toBe(true);
  });

  it('records a manual payment once for a request key and rejects divergent input', async () => {
    const { business, customer } = await shop();
    const { writeManualPayment } = await import('../src/modules/payments/payments.repository.js');
    const key = randomUUID();
    const data = { customerId: customer.id, amount: 20, method: 'CASH', direction: 'IN', attested: true } as const;
    const results = await Promise.all([writeManualPayment(data, business.id, null, key),
      writeManualPayment(data, business.id, null, key)]);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results[0]!.payment.id).toBe(results[1]!.payment.id);
    await expect(writeManualPayment({ ...data, amount: 30 }, business.id, null, key)).rejects.toThrow('already belongs');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).totalSpend.toNumber()).toBe(20);
  });

  it('replays one authorized booking, refuses a competing slot, then reopens capacity after cancellation', async () => {
    const { business, customer } = await shop();
    const other = await prisma.customer.create({ data: { businessId: business.id, waNumber: '233201234568' } });
    await prisma.business.update({ where: { id: business.id }, data: {
      aiAssistMode: 'GROUNDED_AUTO', bookingsEnabled: true,
      businessProfile: { openingHours: { opensAt: '08:00', closesAt: '17:00',
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] } },
    } });
    const service = await prisma.service.create({ data: { businessId: business.id, name: 'Consultation', durationMinutes: 30, capacity: 1 } });
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    startsAt.setUTCHours(10, 0, 0, 0);
    const bookingSource = await prisma.message.create({ data: { businessId: business.id, customerId: customer.id,
      direction: 'INBOUND', waMessageId: randomUUID(), body: `I want to book Consultation at ${startsAt.toISOString()}` } });
    const { book, cancelAppointment, findSlots } = await import('../src/modules/bookings/bookings.service.js');
    const slotQuery = { serviceId: service.id, from: new Date(startsAt.getTime() - 3_600_000), days: 1, limit: 20 };
    expect((await findSlots(business.id, slotQuery)).slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())).toBe(true);
    const booking = { businessId: business.id, serviceId: service.id, customerId: customer.id, startsAt,
      byAssistant: true, assistantMessageId: bookingSource.id };
    const outcomes = await Promise.all([book(booking), book(booking)]);
    expect(outcomes[0]!.id).toBe(outcomes[1]!.id);
    expect((await findSlots(business.id, slotQuery)).slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())).toBe(false);
    await expect(book({ ...booking, customerId: other.id })).rejects.toThrow('current policy');
    await expect(book({ businessId: business.id, serviceId: service.id, customerId: other.id, startsAt })).rejects.toThrow('not available');
    await cancelAppointment(outcomes[0]!.id, business.id, 'Synthetic cancellation');
    expect((await findSlots(business.id, slotQuery)).slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())).toBe(true);
    const second = await book({ businessId: business.id, serviceId: service.id, customerId: other.id, startsAt });
    expect(second.id).not.toBe(outcomes[0]!.id);
  });

  function callback(phone: string, waId: string, opaque: string, recipient: string, status: string, authentic = true) {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
      value: { metadata: { phone_number_id: phone }, statuses: [{ id: waId, status, recipient_id: recipient,
        timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: opaque }] } }] }] });
    return app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', authentic ? secret : 'invalid').update(payload).digest('hex') } });
  }

  it('accepts monotone signed evidence that can arrive before provider acceptance', async () => {
    const { business, customer, phone } = await shop();
    const key = randomUUID();
    const data = { businessId: business.id, customerId: customer.id, to: customer.waNumber, body: 'Synthetic reply' };
    const sendId = (await queue.persistOutboundSend(prisma, data, key))!;
    expect(await queue.persistOutboundSend(prisma, data, key)).toBeNull();
    const providerId = `wamid.${randomUUID()}`;
    expect((await callback(phone, providerId, sendId, customer.waNumber, 'read', false)).statusCode).toBe(401);
    expect((await callback(phone, providerId, sendId, customer.waNumber, 'read')).statusCode).toBe(200);
    fetchMock.mockResolvedValueOnce(Response.json({ messages: [{ id: providerId }] }));
    await outbound.processDurableOutbound(sendId);
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'READ', providerMessageId: providerId });
    await callback(phone, providerId, sendId, customer.waNumber, 'delivered');
    await callback(phone, providerId, sendId, customer.waNumber, 'failed');
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'READ', deliveredAt: expect.any(Date) });
    expect(await prisma.message.count({ where: { waMessageId: providerId, businessId: business.id } })).toBe(1);
  });

  it('holds ambiguous provider outcomes until an exact matching callback resolves them', async () => {
    const { business, customer, phone } = await shop();
    const sendId = (await queue.persistOutboundSend(prisma, { businessId: business.id,
      customerId: customer.id, to: customer.waNumber, body: 'Ambiguous send' }, randomUUID()))!;
    fetchMock.mockClear();
    fetchMock.mockRejectedValueOnce(new Error('synthetic timeout after acceptance'));
    await outbound.processDurableOutbound(sendId);
    await outbound.processDurableOutbound(sendId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const providerId = `wamid.${randomUUID()}`;
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'REVIEW_REQUIRED' });
    await callback(randomUUID(), providerId, sendId, customer.waNumber, 'delivered');
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'REVIEW_REQUIRED' });
    await callback(phone, providerId, sendId, customer.waNumber, 'delivered');
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'DELIVERED', providerMessageId: providerId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers an evicted queue job and holds interrupted provider sends for review', async () => {
    const { business, customer, phone } = await shop();
    const data = { businessId: business.id, customerId: customer.id, to: customer.waNumber, body: 'Recover this intent' };
    const sendId = (await queue.persistOutboundSend(prisma, data, randomUUID()))!;
    await queue.scheduleOutbound(sendId, data);
    const job = await queue.outboundMessagesQueue.getJob(`send-${sendId}`);
    await job!.remove();
    await prisma.whatsAppSend.update({ where: { id: sendId }, data: { nextAttemptAt: new Date(0) } });
    await outbound.recoverDurableOutbound();
    expect(await queue.outboundMessagesQueue.getJob(`send-${sendId}`)).toBeDefined();
    await prisma.whatsAppSend.update({ where: { id: sendId }, data: {
      state: 'SENDING', phoneNumberId: phone, leaseUntil: new Date(0), nextAttemptAt: null,
    } });
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({
      state: 'REVIEW_REQUIRED', reason: 'SEND_WORKER_INTERRUPTED',
    });
  });

  it('keeps an authorized intent when Redis refuses queue writes and recovers the handoff', async () => {
    const { business, customer } = await shop();
    const { redis: fixtureRedis } = await import('../src/config/redis.js');
    const key = randomUUID();
    const [, originalLimit] = await fixtureRedis.config('GET', 'maxmemory') as [string, string];
    await fixtureRedis.config('SET', 'maxmemory', '1');
    let sendId: string;
    try {
      const result = await queue.enqueueOutboundMessage({ businessId: business.id, customerId: customer.id,
        to: customer.waNumber, body: 'Recover after queue refused a write' }, { idempotencyKey: key });
      expect(result).toMatchObject({ accepted: true, queued: false });
      sendId = result.sendId!;
      expect(sendId).toBeDefined();
      expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'AUTHORIZED' });
    } finally {
      await fixtureRedis.config('SET', 'maxmemory', originalLimit);
    }
    await prisma.whatsAppSend.update({ where: { id: sendId }, data: { nextAttemptAt: new Date(0) } });
    await outbound.recoverDurableOutbound();
    expect(await queue.outboundMessagesQueue.getJob(`send-${sendId}`)).toBeDefined();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'QUEUED' });
  });

  it('reconciles signed delivery after a real send process dies in the provider call', async () => {
    const { business, customer, phone } = await shop();
    const sendId = (await queue.persistOutboundSend(prisma, { businessId: business.id, customerId: customer.id,
      to: customer.waNumber, body: 'Crash recovery fixture' }, randomUUID()))!;
    const path = fileURLToPath(new URL('./fixtures/batch-outbound-crash.ts', import.meta.url));
    const child = fork(path, [sendId], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      const signal = AbortSignal.timeout(30_000);
      await Promise.race([
        once(child, 'message', { signal }).then(([message]) => expect(message).toBe('provider-request')),
        exited.then(() => { throw new Error('Send process exited before reaching the synthetic provider'); }),
      ]);
      expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'SENDING', attempts: 1 });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    await prisma.whatsAppSend.update({ where: { id: sendId }, data: { leaseUntil: new Date(0) } });
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'REVIEW_REQUIRED' });
    const providerId = `wamid.${randomUUID()}`;
    await callback(phone, providerId, sendId, customer.waNumber, 'delivered');
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).toMatchObject({ state: 'DELIVERED', attempts: 1 });
    expect(await prisma.message.count({ where: { businessId: business.id, waMessageId: providerId } })).toBe(1);
  }, 45_000);

  it('rejects a foreign recipient and an automation after owner takeover before provider I/O', async () => {
    const { business, customer } = await shop();
    const foreign = await shop();
    const bad = (await queue.persistOutboundSend(prisma, { businessId: business.id, customerId: foreign.customer.id,
      to: foreign.customer.waNumber, body: 'Invalid target' }, randomUUID()))!;
    const interrupted = (await queue.persistOutboundSend(prisma, { businessId: business.id, customerId: customer.id,
      to: customer.waNumber, body: 'Owner answered', suppressIfOwnerRepliedSince: new Date(0).toISOString() }, randomUUID()))!;
    await prisma.message.create({ data: { businessId: business.id, customerId: customer.id, direction: 'OUTBOUND',
      waMessageId: randomUUID(), sentFromApp: true, body: 'Human answer' } });
    fetchMock.mockClear();
    await outbound.processDurableOutbound(bad);
    await outbound.processDurableOutbound(interrupted);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: bad } })).toMatchObject({ state: 'FAILED', reason: 'RECIPIENT_NOT_AUTHORIZED' });
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: interrupted } })).toMatchObject({ state: 'FAILED', reason: 'OWNER_TAKEOVER' });
  });

  it('records permanent provider rejection and refuses an intent pinned to a superseded sender', async () => {
    const { business, customer } = await shop();
    const data = { businessId: business.id, customerId: customer.id, to: customer.waNumber, body: 'Synthetic provider rejection' };
    const rejected = (await queue.persistOutboundSend(prisma, data, randomUUID()))!;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 190, message: 'synthetic token rejection' } }, { status: 401 }));
    await outbound.processDurableOutbound(rejected);
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: rejected } })).toMatchObject({ state: 'FAILED', attempts: 1 });
    const moved = (await queue.persistOutboundSend(prisma, data, randomUUID()))!;
    await prisma.business.update({ where: { id: business.id }, data: { waPhoneNumberId: randomUUID() } });
    await outbound.processDurableOutbound(moved);
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: moved } })).toMatchObject({ state: 'FAILED', reason: 'CONNECTION_CHANGED', attempts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('links a paid order to duplicate-safe dispatch and a durable completion notification', async () => {
    const { business, customer, source, body } = await shop();
    const { order } = await orders.createOrderFromMessage(body, business.id, customer.id, source.id);
    await orders.confirmOrder(order.id, business.id, null);
    const { writeManualPayment } = await import('../src/modules/payments/payments.repository.js');
    await writeManualPayment({ orderId: order.id, customerId: customer.id, method: 'CASH', direction: 'IN',
      amount: 160, attested: true }, business.id, null, randomUUID());
    await orders.markProcessing(order.id, business.id, null);
    const actor = { businessId: business.id, staffId: null } as const;
    const { dispatchOrder, markShipmentDelivered } = await import('../src/modules/shipments/shipments.service.js');
    const sent = await dispatchOrder(order.id, actor, { courier: 'Local courier' });
    expect(await dispatchOrder(order.id, actor, { courier: 'Duplicate should not replace' })).toEqual(sent);
    const delivered = await markShipmentDelivered(order.id, actor);
    expect(await markShipmentDelivered(order.id, actor)).toEqual(delivered);
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { statusHistory: true } });
    expect(row.status).toBe('FULFILLED');
    expect(row.amountPaid.toNumber()).toBe(160);
    expect(row.statusHistory.filter(({ toStatus }) => toStatus === 'FULFILLED')).toHaveLength(1);
    const task = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId: order.id, kind: 'NOTIFY', subject: 'FULFILLED' } });
    expect(task.state).toBe('PENDING');
    const { recoverFulfillment } = await import('../src/workers/fulfillment-recovery.js');
    await Promise.all([recoverFulfillment(), recoverFulfillment()]);
    const notice = await prisma.whatsAppSend.findUniqueOrThrow({ where: { businessId_eventKey: {
      businessId: business.id, eventKey: `order-status-${order.id}-FULFILLED`,
    } } });
    const providerId = `wamid.${randomUUID()}`;
    fetchMock.mockResolvedValueOnce(Response.json({ messages: [{ id: providerId }] }));
    await outbound.processDurableOutbound(notice.id);
    expect(await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ state: 'PROVIDER_ACCEPTED' });
  });
});
