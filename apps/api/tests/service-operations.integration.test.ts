import { createHmac, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient, StaffRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;
const fixtures = database || cache ? describe : describe.skip;
const metaSecret = 'synthetic-batch-four-meta-fixture';
const paySecret = 'sk_test_synthetic_batch_four_fixture';
const minute = 60_000;
const day = 1440 * minute;
const root = '/service-operations';
const hours = Array.from({ length: 7 }, (_, dayIndex) => ({ day: dayIndex, open: '00:00', close: '23:59' }));

fixtures('Batch 4 service operations with signed ingress and PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let producer: ReturnType<typeof import('../src/workers/text-receipt.worker.js').openTextReceiptQueue>;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let workflow: typeof import('../src/modules/workflows/workflow.worker.js');
  let receipts: typeof import('../src/workers/text-receipt.worker.js');
  let outbound: typeof import('../src/workers/outbound.worker.js');
  let payments: typeof import('../src/modules/payments/paystack-settlement.js');
  let releaseRedis: () => void;
  let nextTransaction = 94000;
  const inits = new Map<string, { amount: number; subaccount: string; metadata: Record<string, unknown> }>();
  const charges = new Map<string, Record<string, unknown>>();
  const posted: Record<string, unknown>[] = [];

  beforeAll(async () => {
    if (![database, cache].every((url) => url && new URL(url).hostname === '127.0.0.1' && new URL(url).port) ||
      !new URL(database!).pathname.startsWith('/flowdesk_g1_') || new URL(cache!).port === '6379') {
      throw new Error('Use disposable loopback PostgreSQL and Redis');
    }
    process.env.DATABASE_URL = database;
    const url = new URL(cache!);
    url.pathname = '/14';
    process.env.REDIS_URL = url.href;
    process.env.META_WEBHOOK_SECRET = metaSecret;
    process.env.PAYSTACK_SECRET_KEY = paySecret;
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_synthetic_batch_four_fixture';
    const loopback = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.hostname === 'api.paystack.co' && target.pathname === '/transaction/initialize') {
        const body = JSON.parse(String(options?.body));
        inits.set(body.reference, { amount: body.amount, subaccount: body.subaccount, metadata: JSON.parse(body.metadata) });
        return Response.json({ status: true, data: { reference: body.reference, authorization_url: 'https://service-checkout.invalid/' + body.reference, access_code: 'fixture' } });
      }
      if (target.hostname === 'api.paystack.co' && target.pathname.startsWith('/transaction/verify/')) {
        const charge = charges.get(target.pathname.split('/').at(-1)!);
        return charge ? Response.json({ status: true, data: charge }) : new Response(null, { status: 503 });
      }
      if (target.hostname === 'graph.facebook.com' && target.pathname.endsWith('/messages')) {
        posted.push(JSON.parse(String(options?.body)));
        return Response.json({ messages: [{ id: 'wamid.' + randomUUID() }] });
      }
      if (target.hostname === 'graph.facebook.com' && target.pathname.endsWith('/message_templates')) {
        return Response.json({ data: [{ name: 'fixture_service_notice', language: 'en', status: 'APPROVED', category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Service appointment {{1}}. {{2}} Reply STOP SERVICE UPDATES to opt out of reminders.' }] }] });
      }
      if (target.hostname !== '127.0.0.1') throw new Error('Blocked network access from service fixture');
      return loopback(input, options);
    });
    ({ prisma } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    const connections = await import('../src/config/redis.js');
    await connections.connectRedis();
    releaseRedis = () => [connections.redis, connections.redisSubscriber, connections.sseSubscriber, connections.rateLimitRedis]
      .forEach((client) => client.disconnect());
    app = await (await import('../src/app.js')).createApp();
    workflow = await import('../src/modules/workflows/workflow.worker.js');
    receipts = await import('../src/workers/text-receipt.worker.js');
    outbound = await import('../src/workers/outbound.worker.js');
    payments = await import('../src/modules/payments/paystack-settlement.js');
    producer = receipts.openTextReceiptQueue();
    await producer.ready();
  }, 60_000);

  afterAll(async () => {
    try {
      await producer?.close();
      await outbound?.outboundWorker.close();
      if (outbound) await (await import('../src/queues/outbound.queue.js')).outboundMessagesQueue.close();
      await app?.close();
      await prisma?.$disconnect();
    } finally { releaseRedis?.(); vi.unstubAllGlobals(); }
  }, 30_000);

  const slot = (offset: number) => new Date(Math.ceil((Date.now() + offset) / (15 * minute)) * 15 * minute);
  function expectResponse(response: { statusCode: number; body: string; json: () => { data: any } }, statusCode: number) {
    expect(response.statusCode, response.body).toBe(statusCode);
    return response.json().data;
  }

  async function shop(profile = 'APPOINTMENT') {
    const business = await prisma.business.create({ data: { name: 'Synthetic service shop', ownerName: 'Fixture', bookingsEnabled: true,
      waPhoneNumberId: randomUUID(), waWabaId: '100040004000', waAccessToken: 'synthetic-test-token',
      paystackSubaccountCode: 'ACCT_' + randomUUID(), receiptsEnabled: true } });
    const businessId = business.id;
    const customer = (suffix: number) => prisma.customer.create({ data: { businessId, waNumber: '23320001000' + suffix,
      name: 'Fixture customer ' + suffix, lastInboundAt: new Date(Date.now() - minute) } });
    const [first, second, third] = await Promise.all([customer(1), customer(2), customer(3)]);
    const staff = (suffix: number, role: StaffRole = 'OPERATIONS') => prisma.staff.create({ data: {
      businessId, phone: '23320002000' + suffix, name: 'Worker ' + suffix, role,
    } });
    const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: Record<string, unknown>, actor?: { id: string; role: StaffRole }) =>
      app.inject({ method, url: '/api/v1' + url, ...(payload ? { payload } : {}), headers: { authorization: 'Bearer ' +
        sign({ businessId, plan: 'BUSINESS', ...(actor ? { staffId: actor.id, role: actor.role } : {}) }, '15m') } });
    const settings = { enabled: true, timeZone: 'Africa/Accra', hours, closures: [], reminderMinutes: 15, revision: 0 };
    expectResponse(await api('PUT', root + '/settings', settings), 200);
    await prisma.workflowSettings.create({ data: { businessId, profile, enabled: true } });
    await prisma.$executeRaw`UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(Date.now() - minute)}
      WHERE "businessId" = ${businessId} AND "phoneNumberId" = ${business.waPhoneNumberId!}`;
    const catalogue = (rules: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => ({
      name: 'Service ' + randomUUID().slice(0, 8), revision: 0, priceMinor: 0, durationMinutes: 30, bufferMinutes: 0, capacity: 1,
      rules: { category: 'PERSONAL', location: 'Main office', leadMinutes: 0, changeNoticeMinutes: 0, payment: { kind: 'AFTER_SERVICE' }, ...rules }, ...options,
    });
    const service = async (rules: Record<string, unknown> = {}, changes: Record<string, unknown> = {}) =>
      expectResponse(await api('POST', root + '/catalogue', catalogue(rules, changes)), 201) as { id: string; name: string; bookingRevision: number };
    const resource = async (staffId: string | null, opts: Record<string, unknown> = {}) =>
      expectResponse(await api('POST', root + '/resources', { name: 'Resource', staffId, ...opts }), 201) as { id: string };
    const params = (serviceId: string, startsAt: Date, customerId = first.id, overrides: Record<string, unknown> = {}) => ({
      serviceId, customerId, startsAt: startsAt.toISOString(), serviceRevision: 1, settingsRevision: 1, requestKey: randomUUID(), ...overrides,
    });
    const reserve = (serviceId: string, time: Date, customerId?: string, overrides?: Record<string, unknown>) =>
      api('POST', root + '/visits', params(serviceId, time, customerId, overrides));
    const visit = (appointmentId: string) => prisma.serviceVisit.findUniqueOrThrow({ where: { appointmentId },
      include: { appointment: true, invoice: true, blocks: true, history: true, notices: true } });
    const action = async (id: string, action: string, options: Record<string, unknown> = {}, actor?: { id: string; role: StaffRole }) =>
      api('POST', root + '/visits/' + id + '/actions', { revision: (await visit(id)).revision, action, evidence: 'Synthetic verified observation', ...options }, actor);
    async function meta(value: Record<string, unknown>, duplicates = 1) {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
        value: { metadata: { phone_number_id: business.waPhoneNumberId }, ...value } }] }] });
      const headers = { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex') };
      await Promise.all(Array.from({ length: duplicates }, async () => {
        const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers });
        expect(response.statusCode, response.body).toBe(200);
      }));
    }
    async function signed(body: string, sender = first, duplicates = 1, reconcile = true) {
      const id = 'wamid.' + randomUUID();
      await meta({ messages: [{ id, from: sender.waNumber, type: 'text', text: { body }, timestamp: String(Math.floor(Date.now() / 1000)) }] }, duplicates);
      await receipts.dispatchTextReceipts(producer.enqueue, new Date(), businessId);
      const receipt = await prisma.whatsAppTextReceipt.findUniqueOrThrow({ where: { phoneNumberId_waMessageId: { phoneNumberId: business.waPhoneNumberId!, waMessageId: id } } });
      expect(receipt.status).toBe('COMPLETED');
      if (reconcile) {
        const now = Date.now();
        await workflow.recoverWorkflows(new Date(now + 200));
        await workflow.recoverWorkflows(new Date(now + 2_400));
      }
      return receipt.messageId!;
    }
    async function checkout(invoiceId: string) {
      const response = await api('POST', '/commerce/invoices/' + invoiceId + '/checkout', {});
      expectResponse(response, 200);
      return prisma.paymentRequest.findFirstOrThrow({ where: { businessId, invoiceId, status: 'PENDING' } });
    }
    async function settle(reference: string, ambiguous = false) {
      const payment = inits.get(reference)!;
      const charge = { id: nextTransaction++, reference, amount: payment.amount, currency: 'GHS', domain: 'test', status: 'success',
        paid_at: new Date().toISOString(), channel: 'card', subaccount: { subaccount_code: payment.subaccount }, metadata: payment.metadata };
      if (!ambiguous) charges.set(reference, charge);
      const payload = JSON.stringify({ event: 'charge.success', data: charge });
      const headers = { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', paySecret).update(payload).digest('hex') };
      for (let index = 0; index < 2; index++) expect((await app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload, headers })).statusCode).toBe(200);
      await Promise.all([payments.drainPaystackReceipts(businessId), payments.drainPaystackReceipts(businessId)]);
    }
    return { business, businessId, first, second, third, staff, api, settings, catalogue, resource, service, params, reserve, visit, action, meta, signed, checkout, settle };
  }

  async function interruptWorker(point: string, at: Date, inspect: () => Promise<void>) {
    const child = fork(fileURLToPath(new URL('./fixtures/service-recovery-child.mjs', import.meta.url)), [point, at.toISOString()],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      const hit = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(15_000) }).then(([message]) => message),
        exited.then(([code]) => 'worker exited before checkpoint with ' + code),
      ]);
      expect(hit).toBe(point);
      await inspect();
    } finally {
      child.kill();
      await exited;
    }
  }

  it('admits one signed consultation lead, qualifies, quotes and converts it through the pinned workflow, then completes with signed notice', async () => {
    const f = await shop('PROFESSIONAL_SERVICES');
    const operator = await f.staff(1);
    const practitioner = await f.resource(operator.id);
    const service = await f.service({ category: 'CONSULTATION', staff: [practitioner.id], questions: ['What should the consultant prepare?'] });
    const sourceId = await f.signed('SERVICE ' + service.name + ' | 30 minute consultation', f.first, 3);
    const lead = await prisma.serviceLead.findFirstOrThrow({ where: { businessId: f.businessId, sourceId } });
    expect(await prisma.serviceLead.count({ where: { businessId: f.businessId, sourceId } })).toBe(1);
    expect(await prisma.workflow.findUnique({ where: { id: lead.workflowId! } })).toMatchObject({ version: 4, reason: 'SERVICE_LEAD_NEW' });
    expectResponse(await f.api('PATCH', root + '/leads/' + lead.id, { revision: lead.revision, status: 'QUALIFIED', serviceId: service.id,
      assignedStaffId: operator.id, evidence: 'Requirements confirmed' }), 200);
    await f.signed('TIMES ' + lead.id);
    const picker = await prisma.whatsAppSend.findFirstOrThrow({ where: { businessId: f.businessId, eventKey: { startsWith: 'service-reply-' } } });
    expect(picker.payload).toMatchObject({ body: expect.stringContaining('BOOK ' + lead.id) });
    const time = slot(2 * minute);
    await f.signed('BOOK ' + lead.id + ' ' + time.toISOString() + ' 1 1', f.second);
    expect(await prisma.serviceVisit.count({ where: { leadId: lead.id } })).toBe(0);
    await f.signed('BOOK ' + lead.id + ' ' + time.toISOString() + ' 1 1', f.first, 2);
    const visit = await prisma.serviceVisit.findUniqueOrThrow({ where: { leadId: lead.id } });
    expect(visit).toMatchObject({ state: 'CONFIRMED', assignedStaffId: operator.id, customerId: f.first.id });
    for (const action of ['ACKNOWLEDGE', 'CHECK_IN', 'START', 'COMPLETE']) expectResponse(await f.action(visit.appointmentId, action, {}, operator), 200);
    await workflow.recoverWorkflows(new Date());
    const completed = await f.visit(visit.appointmentId);
    expect(completed.history.map((event) => event.action)).toEqual(['CONFIRMED', 'ACKNOWLEDGE', 'CHECK_IN', 'START', 'COMPLETE']);
    const notice = completed.notices.find(({ kind }) => kind === 'COMPLETE')!;
    expect(notice.sendId).toBeTruthy();
    await outbound.processDurableOutbound(notice.sendId!);
    const accepted = await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: notice.sendId! } });
    expect(accepted.state).toBe('PROVIDER_ACCEPTED');
    await f.meta({ statuses: [{ id: accepted.providerMessageId, recipient_id: f.first.waNumber, status: 'delivered',
      timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: notice.sendId }] });
    await outbound.recoverDurableOutbound();
    expect(await prisma.whatsAppSend.findUnique({ where: { id: notice.sendId! } })).toMatchObject({ state: 'DELIVERED' });
    await workflow.recoverWorkflows(new Date(Date.now() + 5_000));
    expect(await prisma.workflow.findUnique({ where: { id: lead.workflowId! } })).toMatchObject({ state: 'COMPLETED', reason: 'SERVICE_COMPLETION_DELIVERED' });
  }, 60_000);

  it('confirms only an exact independently verified deposit and keeps the balance and booking identity after rescheduling', async () => {
    const f = await shop();
    const service = await f.service({ payment: { kind: 'PERCENT', percent: 25 } }, { priceMinor: 12004 });
    const firstId = expectResponse(await f.reserve(service.id, slot(3 * day)), 201).appointmentId as string;
    const secondId = expectResponse(await f.reserve(service.id, slot(4 * day)), 201).appointmentId as string;
    const initial = await f.visit(firstId);
    expect(initial).toMatchObject({ state: 'HELD', appointment: { status: 'BOOKED' } });
    expect(initial.invoice?.deposit.toFixed(2)).toBe('30.01');
    expect((await f.api('POST', '/commerce/invoices/' + initial.invoiceId + '/checkout', { amountMinor: 3000 })).statusCode).toBe(409);
    expect((await f.api('POST', '/commerce/invoices/' + initial.invoiceId + '/decision', { action: 'CANCEL' })).statusCode).toBe(404);
    const link = await f.checkout(initial.invoiceId!);
    expect(link.amount.toFixed(2)).toBe('30.01');
    await f.settle(link.reference);
    await Promise.all([workflow.recoverWorkflows(new Date()), workflow.recoverWorkflows(new Date())]);
    expect(await f.visit(firstId)).toMatchObject({ state: 'CONFIRMED', holdUntil: null, invoiceId: initial.invoiceId });
    expect(await f.visit(secondId)).toMatchObject({ state: 'HELD' });
    expect(await prisma.payment.count({ where: { invoiceId: initial.invoiceId } })).toBe(1);
    expectResponse(await f.action(firstId, 'RESCHEDULE', { startsAt: slot(5 * day).toISOString() }), 200);
    const moved = await f.visit(firstId);
    expect(moved.invoiceId).toBe(initial.invoiceId);
    expect(moved.appointment.startsAt).not.toEqual(initial.appointment.startsAt);
    const rendered = expectResponse(await f.api('GET', '/commerce/invoices/' + moved.invoiceId), 200);
    expect(rendered).toMatchObject({ verified: '30.01', due: '90.03', nextCharge: '90.03' });
  }, 60_000);

  it('serializes the last slot and replays one commitment with changed parameters rejected', async () => {
    const f = await shop();
    const service = await f.service();
    const time = slot(2 * day);
    const first = f.params(service.id, time);
    const second = f.params(service.id, time, f.second.id);
    const results = await Promise.all([first, first, second, second].map((input) => f.api('POST', root + '/visits', input)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 201, 409, 409]);
    const ids = results.filter((result) => result.statusCode === 201).map((result) => result.json().data.appointmentId);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.serviceVisit.count({ where: { businessId: f.businessId } })).toBe(1);
    const winner = results[0]?.statusCode === 201 ? first : second;
    expect((await f.api('POST', root + '/visits', { ...winner, startsAt: slot(3 * day).toISOString() })).statusCode).toBe(409);
  });

  it('permits real parallel equipment and staff assignments, rejects foreign or unavailable alternatives, and enforces SQL guards', async () => {
    const f = await shop();
    const other = await shop();
    const [a, b] = await Promise.all([f.staff(1), f.staff(2)]);
    const [staffA, staffB, kitA, kitB] = await Promise.all([f.resource(a.id), f.resource(b.id), f.resource(null), f.resource(null)]);
    expect((await f.api('POST', root + '/resources', { name: 'Foreign staff', staffId: (await other.staff(1)).id })).statusCode).toBe(404);
    const service = await f.service({ staff: [staffA.id, staffB.id], equipment: [[kitA.id, kitB.id]], prepMinutes: 15 }, { capacity: 3 });
    const start = slot(2 * day + 3 * 60 * minute);
    const responses = await Promise.all([f.first, f.second, f.third].map(({ id }) => f.reserve(service.id, start, id)));
    expect(responses.map((result) => result.statusCode).sort()).toEqual([201, 201, 409]);
    const ids = responses.filter((result) => result.statusCode === 201).map((result) => result.json().data.appointmentId as string);
    const visits = await Promise.all(ids.map(f.visit));
    expect(new Set(visits.flatMap((visit) => visit.blocks.map((item) => item.resourceId))).size).toBe(4);
    expect(new Set(visits.map((visit) => visit.assignedStaffId))).toEqual(new Set([a.id, b.id]));
    await expect(prisma.serviceReservation.create({ data: { businessId: f.businessId, appointmentId: ids[0]!,
      resourceId: visits[0]!.blocks[0]!.resourceId, startsAt: start, endsAt: new Date(+start + minute) } })).rejects.toThrow(/service_resource_no_overlap/);
    await expect(prisma.appointment.update({ where: { id: ids[0]! }, data: { status: 'COMPLETED' } })).rejects.toThrow(/Managed appointment/);
    await expect(prisma.service.update({ where: { id: service.id }, data: { price: 1 } })).rejects.toThrow(/Managed catalogue/);
    expect((await f.reserve(service.id, new Date(+start + 30 * minute), f.third.id)).statusCode).toBe(409);
  }, 45_000);

  it('releases expiry, preserves late verified settlement and prevents old or cross-tenant checkout', async () => {
    const f = await shop();
    const foreign = await shop();
    const service = await f.service({ payment: { kind: 'FIXED', amountMinor: 2500 }, holdMinutes: 5 }, { priceMinor: 7500 });
    const time = slot(2 * day);
    const id = expectResponse(await f.reserve(service.id, time), 201).appointmentId;
    const initial = await f.visit(id);
    const link = await f.checkout(initial.invoiceId!);
    expect((await foreign.api('GET', '/commerce/invoices/' + initial.invoiceId)).statusCode).toBe(404);
    const prior = new Date(Date.now() - 2_000);
    await prisma.serviceVisit.update({ where: { appointmentId: id }, data: { holdUntil: prior } });
    await workflow.recoverWorkflows(new Date());
    expect(await f.visit(id)).toMatchObject({ state: 'EXPIRED', appointment: { status: 'CANCELLED' } });
    expectResponse(await f.reserve(service.id, time, f.second.id), 201);
    expect((await f.api('POST', '/commerce/invoices/' + initial.invoiceId + '/checkout', {})).statusCode).toBe(409);
    await f.settle(link.reference);
    await workflow.recoverWorkflows(new Date());
    expect(await f.visit(id)).toMatchObject({ state: 'EXPIRED', paymentReviewAt: expect.any(Date) });
    expect(await prisma.payment.findFirst({ where: { invoiceId: initial.invoiceId } })).toMatchObject({
      customerId: f.first.id, orderId: null, confidence: 'GATEWAY_CONFIRMED',
    });
    expect(await prisma.appointment.count({ where: { businessId: f.businessId, startsAt: time, status: { not: 'CANCELLED' } } })).toBe(1);
  }, 60_000);

  it('requires owner approval, checks availability revision and retains explicit ambiguous deposit state', async () => {
    const f = await shop();
    const rules = { approvalRequired: true, payment: { kind: 'FULL' } };
    const attributes = f.catalogue(rules, { name: 'Approved repair', priceMinor: 5600 });
    const service = expectResponse(await f.api('POST', root + '/catalogue', attributes), 201);
    const time = slot(2 * day);
    const previous = f.params(service.id, time);
    expectResponse(await f.api('PUT', root + '/catalogue/' + service.id, { ...attributes, revision: 1, priceMinor: 5900 }), 200);
    expect((await f.api('POST', root + '/visits', previous)).statusCode).toBe(409);
    expectResponse(await f.api('PUT', root + '/settings', { ...f.settings, revision: 1 }), 200);
    expect((await f.reserve(service.id, time, f.first.id, { serviceRevision: 2 })).statusCode).toBe(409);
    const id = expectResponse(await f.reserve(service.id, time, f.first.id, { serviceRevision: 2, settingsRevision: 2 }), 201).appointmentId;
    const approval = { action: 'APPROVE', evidence: 'Approved synthetic terms', revision: 0 };
    const results = await Promise.all([0, 1].map(() => f.api('POST', root + '/visits/' + id + '/actions', approval)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const item = await f.visit(id);
    const link = await f.checkout(item.invoiceId!);
    await f.settle(link.reference, true);
    await workflow.recoverWorkflows(new Date());
    expect(await f.visit(id)).toMatchObject({ state: 'HELD', approvedAt: expect.any(Date) });
    expect(await prisma.payment.count({ where: { invoiceId: item.invoiceId } })).toBe(0);
    expect(await prisma.paystackReceipt.findFirst({ where: { businessId: f.businessId, reference: link.reference } })).toMatchObject({ state: 'WAITING' });
  }, 60_000);

  it('requires assigned staff and physical stage evidence, then allows payment after service', async () => {
    const f = await shop();
    const other = await shop();
    const [a, b, rider] = await Promise.all([f.staff(1), f.staff(2), f.staff(3, 'DELIVERY')]);
    const [staffA, staffB] = await Promise.all([f.resource(a.id), f.resource(b.id)]);
    const service = await f.service({ category: 'REPAIR', stages: ['Diagnosed', 'Repaired'], staff: [staffA.id, staffB.id] }, { priceMinor: 4600 });
    const id = expectResponse(await f.reserve(service.id, slot(minute)), 201).appointmentId as string;
    const first = await f.visit(id);
    expect((await f.api('POST', '/commerce/invoices/' + first.invoiceId + '/checkout', {})).statusCode).toBe(409);
    expect((await other.api('POST', root + '/visits/' + id + '/actions', { action: 'CHECK_IN', revision: 0, evidence: 'Foreign request' })).statusCode).toBe(404);
    expect((await f.action(id, 'CHECK_IN', {}, b)).statusCode).toBe(404);
    expect((await f.api('GET', root, undefined, rider)).statusCode).toBe(403);
    expect((await f.api('GET', '/commerce/invoices/' + first.invoiceId, undefined, rider)).statusCode).toBe(403);
    expectResponse(await f.action(id, 'REASSIGN', { staffId: b.id }), 200);
    expect((await f.action(id, 'CHECK_IN', {}, a)).statusCode).toBe(404);
    const list = expectResponse(await f.api('GET', root, undefined, b), 200);
    expect(list.visits[0]).not.toHaveProperty('invoiceId');
    expect(list.visits[0].service).not.toHaveProperty('totalMinor');
    expect(list).not.toHaveProperty('closedServiceRevenue');
    await prisma.staff.update({ where: { id: b.id }, data: { role: 'DELIVERY' } });
    expect((await f.action(id, 'CHECK_IN', {}, b)).statusCode).toBe(403);
    await prisma.staff.update({ where: { id: b.id }, data: { role: 'OPERATIONS' } });
    for (const action of ['CHECK_IN', 'START']) expectResponse(await f.action(id, action, {}, b), 200);
    expect((await f.action(id, 'COMPLETE', {}, b)).statusCode).toBe(409);
    for (const action of ['STAGE', 'STAGE', 'COMPLETE']) expectResponse(await f.action(id, action, {}, b), 200);
    expect(await f.visit(id)).toMatchObject({ state: 'COMPLETED', stageIndex: 2 });
    expect((await f.checkout(first.invoiceId!)).amount.toFixed(2)).toBe('46.00');
  }, 60_000);

  it('requires a currently approved template outside the window and suppresses stale consent and paid deposit reminders', async () => {
    const f = await shop();
    expectResponse(await f.api('PUT', root + '/settings', { ...f.settings, revision: 1,
      templateName: 'fixture_service_notice', templateLanguage: 'en' }), 200);
    await f.signed('START SERVICE UPDATES');
    const service = await f.service({ approvalRequired: true, payment: { kind: 'FIXED', amountMinor: 3000 } }, { priceMinor: 4800 });
    const heldId = expectResponse(await f.reserve(service.id, slot(2 * day), f.first.id, { settingsRevision: 2 }), 201).appointmentId;
    const link = await f.checkout((await f.visit(heldId)).invoiceId!);
    await f.settle(link.reference);
    await workflow.recoverWorkflows(new Date(Date.now() + 6 * minute));
    expect((await f.visit(heldId)).notices.find(({ kind }) => kind === 'DEPOSIT')).toMatchObject({
      sendId: null, reason: 'DEPOSIT_ALREADY_PAID',
    });
    const next = await f.service();
    const soon = slot(minute);
    const id = expectResponse(await f.reserve(next.id, soon, f.first.id, { settingsRevision: 2 }), 201).appointmentId;
    await prisma.customer.update({ where: { id: f.first.id }, data: { lastInboundAt: new Date(Date.now() - 2 * day) } });
    const at = new Date(Math.max(Date.now(), +soon - 14 * minute));
    await workflow.recoverWorkflows(at);
    expect((await f.visit(id)).notices.find(({ kind }) => kind === 'UPCOMING')).toMatchObject({
      sendId: null, reason: 'APPROVED_TEMPLATE_REQUIRED',
    });
    await workflow.recoverWorkflows(at);
    const notice = (await f.visit(id)).notices.find(({ kind }) => kind === 'UPCOMING')!;
    expect(notice.sendId).toBeTruthy();
    expect((await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: notice.sendId! } })).payload).toMatchObject({
      template: { name: 'fixture_service_notice', language: 'en' },
    });
    await f.signed('STOP SERVICE UPDATES');
    const sent = posted.length;
    await outbound.processDurableOutbound(notice.sendId!);
    expect(posted).toHaveLength(sent);
    expect(await prisma.whatsAppSend.findUnique({ where: { id: notice.sendId! } })).toMatchObject({ state: 'FAILED', reason: 'NOTICE_CONSENT_REQUIRED' });
  }, 65_000);

  it('cancels stale reminder before provider execution and accepts only authorized no-show evidence and care resolution', async () => {
    const f = await shop();
    const service = await f.service();
    await f.signed('START SERVICE UPDATES');
    const time = slot(2 * day);
    const id = expectResponse(await f.reserve(service.id, time), 201).appointmentId as string;
    await prisma.customer.update({ where: { id: f.first.id }, data: { lastInboundAt: new Date(+time - 40 * minute) } });
    await workflow.recoverWorkflows(new Date(+time - 15 * minute));
    const notice = (await f.visit(id)).notices.find(({ kind }) => kind === 'UPCOMING')!;
    expect(notice.sendId).toBeTruthy();
    const sent = posted.length;
    expectResponse(await f.action(id, 'CANCEL'), 200);
    await outbound.processDurableOutbound(notice.sendId!);
    expect(posted).toHaveLength(sent);
    expect(await prisma.whatsAppSend.findUnique({ where: { id: notice.sendId! } })).toMatchObject({ state: 'FAILED' });
    const replacement = expectResponse(await f.reserve(service.id, time, f.second.id), 201).appointmentId as string;
    expect((await f.action(replacement, 'NO_SHOW')).statusCode).toBe(409);
    const { updateServiceVisit } = await import('../src/modules/bookings/service.visits.js');
    await prisma.$transaction((tx) => updateServiceVisit(tx, { businessId: f.businessId, staffId: null }, replacement,
      { action: 'NO_SHOW', evidence: 'Staff confirmed absent after opening the appointment', revision: 0 }, new Date(+time + 16 * minute)));
    expect(await f.visit(replacement)).toMatchObject({ state: 'NO_SHOW' });
    const inquiry = await f.signed('QUALITY ' + (await f.visit(id)).appointment.reference + ' Complaint about the appointment');
    const item = await prisma.commerceCase.findFirstOrThrow({ where: { sourceId: inquiry, businessId: f.businessId } });
    const resolve = (source: string) => f.api('PATCH', '/commerce/cases/' + item.id, { revision: 0, state: 'RESOLVED', staffId: null,
      evidenceMessageId: source, resolution: 'CUSTOMER_CONFIRMED_RESOLUTION' });
    expect((await resolve(await f.signed('RESOLVED ' + item.id, f.second))).statusCode).toBe(404);
    expectResponse(await resolve(await f.signed('RESOLVED ' + item.id)), 200);
    await workflow.recoverWorkflows(new Date(Date.now() + 5_000));
    expect(await prisma.workflow.findFirst({ where: { businessId: f.businessId, sourceId: inquiry } })).toMatchObject({ reason: 'SERVICE_CASE_RESOLVED' });
  }, 60_000);

  it('applies a local closure at midnight and disambiguates both repeated DST instants with buffer constraints', async () => {
    const f = await shop();
    const { managedSlots } = await import('../src/modules/bookings/service.schedule.js');
    const { isWithinHours, localSlotAllowed } = await import('../src/modules/bookings/service.calendar.js');
    const zone = 'America/New_York';
    const sunday = [{ day: 0, open: '00:00', close: '04:00' }];
    const autumn = new Date('2026-11-01T04:00:00Z');
    const now = new Date('2026-10-31T23:00:00Z');
    expectResponse(await f.api('PUT', root + '/settings', { ...f.settings, revision: 1, timeZone: zone, hours: sunday }), 200);
    const service = await f.service({ prepMinutes: 15 }, { durationMinutes: 15, bufferMinutes: 15 });
    const preview = () => managedSlots(prisma, f.businessId, service.id, autumn, 1, 1, now);
    const instants = (await preview()).slots.map(({ startsAt }) => startsAt.toISOString());
    expect(instants).toContain('2026-11-01T05:00:00.000Z');
    expect(instants).toContain('2026-11-01T06:00:00.000Z');
    expect(instants).not.toContain('2026-11-01T04:00:00.000Z');
    expect(instants).not.toContain('2026-11-01T08:45:00.000Z');
    expectResponse(await f.api('PUT', root + '/settings', { ...f.settings, revision: 2, timeZone: zone, hours: sunday, closures: ['2026-11-01'] }), 200);
    expect((await preview()).slots).toHaveLength(0);
    expect(isWithinHours(new Date('2026-03-08T06:45:00Z'), new Date('2026-03-08T07:15:00Z'), zone, sunday, [])).toBe(true);
    expect(isWithinHours(new Date('2026-03-08T04:55:00Z'), new Date('2026-03-08T05:15:00Z'), zone, sunday, [])).toBe(false);
    expect(localSlotAllowed(new Date('2026-11-02T05:00:00Z'), now, zone, 0, 1)).toBe(false);
  }, 60_000);

  it('recovers one reservation, confirmation and notice after actual worker termination in each transaction', async () => {
    const f = await shop();
    const service = await f.service({ payment: { kind: 'FIXED', amountMinor: 2000 } }, { priceMinor: 5000 });
    const sourceId = await f.signed('SERVICE ' + service.name);
    const lead = await prisma.serviceLead.findFirstOrThrow({ where: { businessId: f.businessId, sourceId } });
    expectResponse(await f.api('PATCH', root + '/leads/' + lead.id, { revision: 0, status: 'QUALIFIED', serviceId: service.id,
      assignedStaffId: null, evidence: 'Qualified fixture request' }), 200);
    const startsAt = slot(3 * day);
    const command = await f.signed('BOOK ' + lead.id + ' ' + startsAt.toISOString() + ' 1 1', f.first, 1, false);
    await workflow.recoverWorkflows(new Date(Date.now() + 250));
    const resumeAt = new Date(Date.now() + 4_000);
    const reservations = () => prisma.serviceVisit.count({ where: { leadId: lead.id } });
    await interruptWorker('before-service-reservation-commit', resumeAt, async () => {
      expect(await reservations()).toBe(0);
      expect(await prisma.workflow.findFirst({ where: { sourceId: command } })).toMatchObject({ state: 'RUNNING' });
    });
    await expect.poll(async () => {
      await workflow.recoverWorkflows(resumeAt);
      return reservations();
    }, { timeout: 12_000, interval: 250 }).toBe(1);
    const visit = await prisma.serviceVisit.findUniqueOrThrow({ where: { leadId: lead.id } });
    const link = await f.checkout(visit.invoiceId!);
    await f.settle(link.reference);
    await interruptWorker('before-service-confirmation-commit', new Date(), async () => {
      expect(await f.visit(visit.appointmentId)).toMatchObject({ state: 'HELD' });
      expect(await prisma.payment.count({ where: { invoiceId: visit.invoiceId } })).toBe(1);
    });
    const beforeNotice = await prisma.whatsAppSend.count({ where: { businessId: f.businessId, eventKey: { startsWith: 'service-notice-' } } });
    await interruptWorker('before-service-notice-commit', new Date(), async () => {
      expect(await prisma.whatsAppSend.count({ where: { businessId: f.businessId, eventKey: { startsWith: 'service-notice-' } } })).toBe(beforeNotice);
    });
    await workflow.recoverWorkflows(new Date());
    await workflow.recoverWorkflows(new Date());
    expect(await f.visit(visit.appointmentId)).toMatchObject({ state: 'CONFIRMED', holdUntil: null });
    expect(await reservations()).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId: visit.invoiceId } })).toBe(1);
    const notice = await prisma.serviceVisitNotice.findFirstOrThrow({ where: { appointmentId: visit.appointmentId, kind: 'CONFIRMED' } });
    expect(await prisma.whatsAppSend.count({ where: { businessId: f.businessId, eventKey: 'service-notice-' + notice.id } })).toBe(1);
  }, 85_000);
});
