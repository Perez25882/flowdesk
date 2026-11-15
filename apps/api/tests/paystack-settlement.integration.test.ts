import { fork } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { IntentType } from '@flowdesk/shared';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dbUrl = process.env.G1_03_TEST_DATABASE_URL;
const redisUrl = process.env.G1_03_TEST_REDIS_URL;
const upgradeUrl = process.env.G1_03_UPGRADE_DATABASE_URL;
const secret = 'sk_test_flowdesk_g103_synthetic';
const fixtureOnly = dbUrl || redisUrl || upgradeUrl ? describe : describe.skip;
const maxId = '18446744073709551615';
const metaSecret = 'batch-retail-synthetic-meta-signing-secret';
const assistant = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../src/services/intent/assistant-providers/nvidia.js', () => ({
  NvidiaAssistantProvider: class { name = 'synthetic'; generate = assistant.generate; },
}));

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
  const metaCalls = new Map<string, string>();
  let failInitialization = false;

  beforeAll(async () => {
    for (const url of [dbUrl, redisUrl, upgradeUrl]) {
      if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Use dedicated IPv4 loopback fixtures');
    }
    const fixtureDatabase = new URL(dbUrl!);
    if (!fixtureDatabase.searchParams.has('connection_limit')) fixtureDatabase.searchParams.set('connection_limit', '8');
    fixtureDatabase.searchParams.set('pool_timeout', '10');
    process.env.DATABASE_URL = fixtureDatabase.toString();
    const isolatedCache = new URL(redisUrl!);
    isolatedCache.pathname = '/3';
    process.env.REDIS_URL = isolatedCache.href;
    process.env.PAYSTACK_SECRET_KEY = secret;
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_flowdesk_g103_synthetic';
    process.env.META_WEBHOOK_SECRET = metaSecret;
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'synthetic-local-fixture';
    process.env.HAIKU_FALLBACK_ENABLED = 'false';
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
      if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/messages')) {
        const id = `wamid.${randomUUID()}`;
        metaCalls.set(JSON.parse(String(options?.body)).biz_opaque_callback_data, id);
        return Response.json({ messages: [{ id }] });
      }
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

  it('takes three G1 retail journeys and a Batch 2 operator journey through the running workers', async () => {
    const { createApp } = await import('../src/app.js');
    const { signAccessToken } = await import('../src/services/auth/tokens.js');
    const { intentClassifierWorker } = await import('../src/workers/intent-classifier.worker.js');
    const outbound = await import('../src/workers/outbound.worker.js');
    const { dispatchTextReceipts, openTextReceiptQueue, recoverClassificationHandoffs } = await import('../src/workers/text-receipt.worker.js');
    const { startFulfillmentRecovery } = await import('../src/workers/fulfillment-recovery.js');
    const { startWorkflowRecovery } = await import('../src/modules/workflows/workflow.worker.js');
    const api = await createApp();
    const producer = openTextReceiptQueue();
    const workers = [intentClassifierWorker, outbound.outboundWorker];
    const workerErrors: string[] = [];
    for (const worker of workers) worker.on('error', (error) => workerErrors.push(error.name));
    const running = workers.map((worker) => worker.run().catch((error: Error) => { workerErrors.push(error.name); }));
    const stopOutbound = outbound.startDurableOutboundRecovery();
    const stopFulfillment = startFulfillmentRecovery();
    const stopWorkflow = startWorkflowRecovery();

    const foreign = await shop(true);
    function owner(businessId: string) {
      return { authorization: 'Bearer ' + signAccessToken({ businessId, plan: 'BUSINESS' }, '15m') };
    }

    await producer.ready();
    try {
      for (let run = 0; run < 4; run++) {
        const fixture = await shop(true);
        const phone = randomUUID();
        await prisma.business.update({ where: { id: fixture.tenant.id }, data: {
          aiAssistMode: 'GROUNDED_AUTO', waPhoneNumberId: phone, waAccessToken: 'synthetic-batch-token',
        } });
        await prisma.$executeRaw`
          UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(Date.now() - 60_000)}
          WHERE "phoneNumberId" = ${phone} AND "businessId" = ${fixture.tenant.id} AND "endedAt" IS NULL
        `;
        const product = await prisma.product.create({ data: {
          businessId: fixture.tenant.id, name: 'Rice', unit: 'bag', price: 25, stockQuantity: 10,
        } });
        const account = owner(fixture.tenant.id);
        if (run === 3) {
          const enabled = await api.inject({ method: 'PUT', url: '/api/v1/workflow-settings', headers: account,
            payload: { profile: 'ONLINE_RETAIL', enabled: true, supportMode: 'VERIFIED_STATUS', revision: 0 } });
          expect(enabled.statusCode, enabled.body).toBe(200);
        }
        async function signedMeta(value: Record<string, unknown>) {
          const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
            value: { metadata: { phone_number_id: phone }, ...value },
          }] }] });
          const response = await api.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex'),
          } });
          expect(response.statusCode, response.body).toBe(200);
        }

        async function admitText(body: string, replyTo?: string, sender = fixture.customer.waNumber) {
          const providerId = 'wamid.' + randomUUID();
          const value = { messages: [{ id: providerId, from: sender,
            type: 'text', text: { body }, timestamp: String(Math.floor(Date.now() / 1000)),
            ...(replyTo ? { context: { id: replyTo } } : {}) }] };
          await signedMeta(value);
          await signedMeta(value);
          const where = { phoneNumberId_waMessageId: { phoneNumberId: phone, waMessageId: providerId } };
          expect(await prisma.whatsAppTextReceipt.findUniqueOrThrow({ where })).toMatchObject({ businessId: fixture.tenant.id, status: 'PENDING' });
          await dispatchTextReceipts(producer.enqueue, new Date(), fixture.tenant.id);
          const receipt = await prisma.whatsAppTextReceipt.findUniqueOrThrow({ where });
          expect(receipt).toMatchObject({ status: 'COMPLETED', messageId: expect.any(String) });
          await expect.poll(async () => {
            const row = await prisma.message.findUniqueOrThrow({ where: { id: receipt.messageId! } });
            return { processed: row.processed, processingError: row.processingError };
          }, { timeout: 25_000 }).toEqual({ processed: true, processingError: null });
          return prisma.message.findUniqueOrThrow({ where: { id: receipt.messageId! } });
        }

        assistant.generate.mockResolvedValue({ ok: true, generation: {
          model: 'synthetic', inputTokens: 1, outputTokens: 1, text: JSON.stringify({
            intent: IntentType.INQUIRY, confidence: 0.99, language: 'gh_en', sentiment: 'neutral',
            entities: { products: [], orderReferences: [], deliveryArea: null },
            answer: { canAnswer: true, text: null, groundedOn: [], fact: { kind: 'product_quote', target: product.id, quantity: null } },
            clarification: { needed: false, missing: [] }, order: { isOrder: false, complete: false },
            escalate: { needed: false, reason: null }, priceOffer: null, booking: null,
          }),
        } });
        const inquiry = await admitText('How much is Rice?');
        expect(inquiry.aiPolicy).toMatchObject({ state: 'HANDED_OFF', evidence: ['product:' + product.id] });
        const quote = await prisma.whatsAppSend.findUniqueOrThrow({ where: { businessId_eventKey: {
          businessId: fixture.tenant.id, eventKey: 'assistant-reply-' + inquiry.id,
        } } });
        expect(quote.payload).toMatchObject({ body: expect.stringContaining('GHS 25.00'), customerId: fixture.customer.id });
        await expect.poll(async () => {
          const send = await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: quote.id } });
          return { state: send.state, reason: send.reason, providerMessageId: send.providerMessageId };
        }, { timeout: 40_000 }).toMatchObject({ state: 'PROVIDER_ACCEPTED', reason: null, providerMessageId: expect.stringMatching(/^wamid\./) });
        expect(metaCalls.get(quote.id)).toBeDefined();
        if (run === 3) {
          await expect.poll(async () => (await prisma.workflow.findFirst({ where: { sourceId: inquiry.id } }))?.state,
            { timeout: 20_000 }).toBe('WAITING_CUSTOMER');
        }

        await prisma.business.update({ where: { id: fixture.tenant.id }, data: { aiAssistMode: 'OFF' } });
        const source = await admitText('I want to buy 1 bag of Rice', run === 3 ? metaCalls.get(quote.id) : undefined);
        const order = await prisma.order.findUniqueOrThrow({ where: { inboundSourceMessageId: source.id } });
        expect(source).toMatchObject({ relatedOrderId: order.id, customerId: fixture.customer.id, businessId: fixture.tenant.id });
        expect(Number(order.totalAmount)).toBe(25);
        const setStatus = (status: string) => api.inject({ method: 'PATCH', url: '/api/v1/orders/' + order.id + '/status',
          headers: account, payload: { status },
        });
        expect((await setStatus('CONFIRMED')).statusCode).toBe(200);

        let checkoutSourceId: string | undefined;
        if (run === 3) {
          await prisma.business.update({ where: { id: fixture.tenant.id }, data: { aiAssistMode: 'AUTONOMOUS', autonomyAcceptedAt: new Date() } });
          assistant.generate.mockResolvedValue({ ok: true, generation: { model: 'synthetic', inputTokens: 1, outputTokens: 1, text: JSON.stringify({
            intent: IntentType.PAYMENT, confidence: 0.99, language: 'gh_en', sentiment: 'neutral',
            entities: { products: [], orderReferences: [], deliveryArea: null }, answer: { canAnswer: false, text: null, groundedOn: [], fact: null },
            clarification: { needed: false, missing: [] }, order: { isOrder: false, complete: false },
            escalate: { needed: false, reason: null }, priceOffer: null, booking: null,
          }) } });
          const ask = await admitText('Send me a payment link');
          expect(ask.aiPolicy).toMatchObject({ state: 'HANDED_OFF', effect: 'checkout' });
          checkoutSourceId = ask.id;
        } else {
          const checkout = await api.inject({ method: 'POST', url: '/api/v1/payments/links', headers: account,
            payload: { customerId: fixture.customer.id, orderId: order.id, amount: 25, send: false },
          });
          expect(checkout.statusCode, checkout.body).toBe(201);
        }
        const requests = await prisma.paymentRequest.findMany({ where: { businessId: fixture.tenant.id, orderId: order.id } });
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        if (run === 3) {
          await expect.poll(async () => (await prisma.workflow.findFirst({ where: { actionSourceId: source.id } }))?.reason,
            { timeout: 20_000 }).toBe('AWAITING_VERIFIED_PAYMENT');
        }
        const sale = { ...fixture, order, request };
        verify(sale);
        await Promise.all([accept(sale), accept(sale)]);
        await drain(fixture.tenant.id);
        const payment = await prisma.payment.findFirstOrThrow({ where: { businessId: fixture.tenant.id, orderId: order.id } });
        expect(payment).toMatchObject({ confidence: 'GATEWAY_CONFIRMED', customerId: fixture.customer.id });
        expect(Number(payment.amount)).toBe(25);
        expect(await prisma.paystackSettlement.count({ where: { requestId: request.id } })).toBe(1);
        expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

        expect((await setStatus('PROCESSING')).statusCode).toBe(200);
        const dispatchUrl = '/api/v1/orders/' + order.id + '/dispatch';
        expect((await api.inject({ method: 'POST', url: dispatchUrl, headers: owner(foreign.tenant.id), payload: {} })).statusCode).toBe(404);
        expect((await api.inject({ method: 'POST', url: dispatchUrl, headers: account, payload: { courier: 'Synthetic carrier' } })).statusCode).toBe(200);
        for (let repeat = 0; repeat < 2; repeat++) {
          expect((await api.inject({ method: 'POST', url: dispatchUrl + '/delivered', headers: account })).statusCode).toBe(200);
        }
        expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id, toStatus: 'FULFILLED' } })).toBe(1);
        expect(await prisma.order.count({ where: { businessId: fixture.tenant.id } })).toBe(1);
        const noticeKey = { businessId: fixture.tenant.id, eventKey: 'order-status-' + order.id + '-FULFILLED' };
        await expect.poll(async () =>
          (await prisma.whatsAppSend.findUnique({ where: { businessId_eventKey: noticeKey } }))?.state,
        { timeout: 40_000, interval: 300 }).toBe('PROVIDER_ACCEPTED');
        const notification = await prisma.whatsAppSend.findUniqueOrThrow({ where: { businessId_eventKey: noticeKey } });
        expect(notification.payload).toMatchObject({ customerId: fixture.customer.id, relatedOrderId: order.id });
        const status = { statuses: [{ id: notification.providerMessageId, status: 'delivered',
          recipient_id: fixture.customer.waNumber, timestamp: String(Math.floor(Date.now() / 1000)),
          biz_opaque_callback_data: notification.id,
        }] };
        await signedMeta(status);
        await signedMeta(status);
        await expect.poll(() => prisma.whatsAppSend.findUniqueOrThrow({ where: { id: notification.id } }), { timeout: 15_000 })
          .toMatchObject({ state: 'DELIVERED', attempts: 1, deliveredAt: expect.any(Date) });
        if (run === 3) {
          const trigger = { businessId_sourceId: { businessId: fixture.tenant.id, sourceId: inquiry.id } };
          await expect.poll(async () => (await prisma.workflow.findUnique({ where: trigger }))?.state,
            { timeout: 30_000 }).toBe('COMPLETED');
          const execution = await prisma.workflow.findUniqueOrThrow({ where: trigger,
            include: { evidence: { orderBy: { id: 'asc' } } } });
          expect(execution).toMatchObject({ orderId: order.id, actionSourceId: source.id, operator: 'CARE', version: 1 });
          expect(execution.evidence.map((entry) => entry.eventType)).toEqual(expect.arrayContaining([
            'WHATSAPP_INBOUND', 'PROCESSING', 'SALES_QUOTE', 'ORDER_LINKED', 'PAYMENT_REQUEST', 'PAYMENT_SETTLED', 'DELIVERY_DISPATCHED',
            'DELIVERY_COMPLETED', 'OUTBOUND_CONFIRMED',
          ]));
          expect((await api.inject({ url: '/api/v1/workflows/' + execution.id, headers: owner(foreign.tenant.id) })).statusCode).toBe(404);

          const getWork = (sourceId: string) => prisma.workflow.findUniqueOrThrow({ where: {
            businessId_sourceId: { businessId: fixture.tenant.id, sourceId },
          } });
          async function confirmSend(sendId: string) {
            await expect.poll(async () => (await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } })).state,
              { timeout: 25_000 }).toBe('PROVIDER_ACCEPTED');
            const send = await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: sendId } });
            await signedMeta({ statuses: [{ id: send.providerMessageId, status: 'delivered', recipient_id: fixture.customer.waNumber,
              timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: sendId }] });
          }
          await expect.poll(async () => (await getWork(checkoutSourceId!)).sendId, { timeout: 20_000 }).toEqual(expect.any(String));
          await confirmSend((await getWork(checkoutSourceId!)).sendId!);
          await expect.poll(async () => (await getWork(checkoutSourceId!)).state, { timeout: 20_000 }).toBe('COMPLETED');
          const question = await admitText('What is the payment status for ' + order.referenceNumber + '?');
          await expect.poll(async () => (await getWork(question.id)).sendId, { timeout: 20_000 }).toEqual(expect.any(String));
          await confirmSend((await getWork(question.id)).sendId!);
          await expect.poll(async () => (await getWork(question.id)).state, { timeout: 20_000 }).toBe('COMPLETED');
          const unknown = await admitText('What is the payment status for FD-UNKNOWN?');
          await expect.poll(async () => (await getWork(unknown.id)).reason, { timeout: 20_000 }).toBe('SUPPORT_EVIDENCE_UNAVAILABLE');

          expect((await api.inject({ method: 'PUT', url: '/api/v1/workflow-settings', headers: account,
            payload: { profile: 'ONLINE_RETAIL', enabled: true, supportMode: 'OWNER_REVIEW', revision: 1 } })).statusCode).toBe(200);
          const held = await admitText('Where is my order ' + order.referenceNumber + '?');
          await expect.poll(async () => (await getWork(held.id)).state, { timeout: 20_000 }).toBe('WAITING_OWNER_APPROVAL');
          const waiting = await getWork(held.id);
          const { env } = await import('../src/config/env.js');
          const versionBefore = env.WORKFLOW_DEFINITION_VERSION;
          env.WORKFLOW_DEFINITION_VERSION = '2';
          const decide = (headers: ReturnType<typeof owner>) => api.inject({ method: 'POST',
            url: '/api/v1/workflows/' + waiting.id + '/decision', headers, payload: { revision: waiting.revision, approve: true } });
          expect((await decide(owner(foreign.tenant.id))).statusCode).toBe(404);
          const decisions = await Promise.all([decide(account), decide(account)]);
          expect(decisions.map((decision) => decision.statusCode).sort()).toEqual([200, 409]);
          await expect.poll(async () => (await getWork(held.id)).sendId, { timeout: 20_000 }).toEqual(expect.any(String));
          await confirmSend((await getWork(held.id)).sendId!);
          await expect.poll(async () => (await getWork(held.id)).state, { timeout: 20_000 }).toBe('COMPLETED');
          expect((await getWork(held.id)).version).toBe(1);

          const toCancel = await admitText('Where is my package, ' + order.referenceNumber + '?');
          await expect.poll(async () => (await getWork(toCancel.id)).state, { timeout: 20_000 }).toBe('WAITING_OWNER_APPROVAL');
          const open = await getWork(toCancel.id);
          expect(open.version).toBe(2);
          env.WORKFLOW_DEFINITION_VERSION = versionBefore;
          expect((await api.inject({ method: 'POST', url: '/api/v1/workflows/' + open.id + '/cancel', headers: account,
            payload: { revision: open.revision } })).statusCode).toBe(200);
          expect((await api.inject({ method: 'POST', url: '/api/v1/workflows/' + open.id + '/decision', headers: account,
            payload: { revision: open.revision, approve: true } })).statusCode).toBe(409);
          expect(await getWork(toCancel.id)).toMatchObject({ state: 'CANCELLED', sendId: null, dueAt: null });

          expect((await api.inject({ method: 'PUT', url: '/api/v1/workflow-settings', headers: account,
            payload: { profile: 'APPOINTMENT', enabled: true, supportMode: 'OWNER_REVIEW', revision: 2 } })).statusCode).toBe(200);
          await prisma.business.update({ where: { id: fixture.tenant.id }, data: {
            aiAssistMode: 'GROUNDED_AUTO', bookingsEnabled: true,
            businessProfile: { openingHours: { opensAt: '08:00', closesAt: '17:00',
              days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] } },
          } });
          const service = await prisma.service.create({ data: { businessId: fixture.tenant.id, name: 'Consultation', durationMinutes: 30 } });
          const { findSlots } = await import('../src/modules/bookings/bookings.service.js');
          const { slots } = await findSlots(fixture.tenant.id, { serviceId: service.id, from: new Date(Date.now() + 2 * 60 * 60_000), days: 14, limit: 8 });
          expect(slots.length).toBeGreaterThan(0);
          assistant.generate.mockResolvedValue({ ok: true, generation: { model: 'synthetic', inputTokens: 1, outputTokens: 1, text: JSON.stringify({
            intent: IntentType.INQUIRY, confidence: 0.99, language: 'gh_en', sentiment: 'neutral',
            entities: { products: [], orderReferences: [], deliveryArea: null }, answer: { canAnswer: true, text: null, groundedOn: [], fact: null },
            clarification: { needed: false, missing: [] }, order: { isOrder: false, complete: false },
            escalate: { needed: false, reason: null }, priceOffer: null, booking: { serviceId: service.id, startsAt: slots[0]!.startsAt.toISOString() },
          }) } });
          const booking = await admitText('Book Consultation ' + slots[0]!.startsAt.toISOString());
          await expect.poll(async () => (await getWork(booking.id)).sendId, { timeout: 20_000 }).toEqual(expect.any(String));
          await confirmSend((await getWork(booking.id)).sendId!);
          await expect.poll(async () => (await getWork(booking.id)).state, { timeout: 20_000 }).toBe('COMPLETED');
          const appointment = await prisma.appointment.findUniqueOrThrow({ where: { assistantMessageId: booking.id } });
          const duplicateSlot = await admitText(booking.body!, undefined, '233209999999');
          await expect.poll(async () => (await getWork(duplicateSlot.id)).state, { timeout: 20_000 }).toBe('REVIEW_REQUIRED');
          expect(await prisma.appointment.count({ where: { businessId: fixture.tenant.id } })).toBe(1);
          const rider = await prisma.staff.create({ data: { businessId: fixture.tenant.id, name: 'Synthetic rider',
            phone: '233202334455', role: 'DELIVERY', inviteAcceptedAt: new Date() } });
          const cancelAppointment = (headers: ReturnType<typeof owner>) => api.inject({ method: 'PATCH',
            url: '/api/v1/appointments/' + appointment.id, headers, payload: { status: 'CANCELLED' } });
          const riderAccount = { authorization: 'Bearer ' + signAccessToken({ businessId: fixture.tenant.id,
            staffId: rider.id, role: 'DELIVERY', plan: 'BUSINESS' }, '15m') };
          expect((await cancelAppointment(riderAccount)).statusCode).toBe(403);
          expect((await api.inject({ url: '/api/v1/workflows', headers: riderAccount })).statusCode).toBe(403);
          expect((await cancelAppointment(account)).statusCode).toBe(200);
          expect(await prisma.appointment.findUnique({ where: { id: appointment.id } })).toMatchObject({ status: 'CANCELLED' });
        }
        await recoverClassificationHandoffs(producer.enqueue, new Date(Date.now() + 40_000));
      }
      expect(workerErrors).toEqual([]);
    } finally {
      await Promise.all([stopOutbound(), stopFulfillment(), stopWorkflow()]);
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(running);
      await producer.close();
      await api.close();
    }
  }, 240_000);

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
    const { logger } = await import('../src/config/logger.js');
    const log = vi.spyOn(logger, 'error');
    try {
      const replies = await Promise.all([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4].map((nonce) =>
        signed(payload(fixture.request.reference, fixture.transactionId, nonce))));
      const admissionCodes = log.mock.calls.flatMap(([details]) =>
        details && typeof details === 'object' && 'databaseCode' in details ? [details.databaseCode] : []);
      expect(replies.map((reply) => reply.statusCode), JSON.stringify({ admissionCodes })).toEqual(Array(12).fill(200));
    } finally {
      log.mockRestore();
    }
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference } })).toBe(5);
    await Promise.all(Array.from({ length: 5 }, () => drain(fixture.tenant.id)));
    expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference, state: 'SETTLED' } })).toBe(5);
    await expectCredit(fixture, 1);
  });

  it('reports the Prisma code for saturated admission and settles the exact retry once', async () => {
    const fixture = await shop();
    verify(fixture);
    const { logger } = await import('../src/config/logger.js');
    const log = vi.spyOn(logger, 'error');
    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const limit = Number(new URL(process.env.DATABASE_URL!).searchParams.get('connection_limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Set a bounded fixture connection_limit');
    // Saturate the same Prisma pool used by the webhook. The fixture sets
    // a short statement acquisition timeout so the 503 is deterministic.
    const held: Array<Promise<unknown>> = [];
    try {
      for (let i = 0; i < limit; i++) {
        let ready!: () => void;
        const started = new Promise<void>((resolve) => { ready = resolve; });
        const transaction = prisma.$transaction(async () => {
          ready();
          await releaseLock;
        }, { maxWait: 10_000, timeout: 60_000 });
        held.push(transaction);
        await Promise.race([started, transaction]);
      }
      const first = await signed(payload(fixture.request.reference, fixture.transactionId));
      release();
      await Promise.all(held);
      expect(first.statusCode).toBe(503);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ databaseCode: 'P2024' }), 'Paystack receipt not durably accepted');
      expect(await prisma.paystackReceipt.count({ where: { reference: fixture.request.reference } })).toBe(0);
      await accept(fixture);
      await drain(fixture.tenant.id);
      await expectCredit(fixture, 1);
    } finally {
      release();
      await Promise.allSettled(held);
      log.mockRestore();
    }
  }, 90_000);

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
    const send = await prisma.whatsAppSend.findUniqueOrThrow({ where: { businessId_eventKey: {
      businessId: fixture.tenant.id, eventKey: `receipt-${settlement.paymentId}`,
    } } });
    const job = await outboundQueue.getJob(`send-${send.id}`);
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
