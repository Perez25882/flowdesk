import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;
const fixtureOnly = database || cache ? describe : describe.skip;
const metaSecret = 'batch-three-synthetic-meta-signing-secret';
const paystackSecret = 'sk_test_batch_three_local_fixture';

fixtureOnly('Batch 3 commerce on PostgreSQL and BullMQ', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let disconnectRedis: (() => void) | undefined;
  const pending = new Map<string, { amount: number; subaccount: string; metadata: Record<string, string> }>();
  const charged = new Map<string, string>();

  beforeAll(async () => {
    if (![database, cache].every((url) => url && new URL(url).hostname === '127.0.0.1')) throw new Error('Use disposable IPv4 fixtures');
    process.env.DATABASE_URL = database;
    const redis = new URL(cache!);
    redis.pathname = '/5';
    process.env.REDIS_URL = redis.href;
    process.env.META_WEBHOOK_SECRET = metaSecret;
    process.env.PAYSTACK_SECRET_KEY = paystackSecret;
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_batch_three_local_fixture';
    process.env.AI_PROVIDER = 'anthropic';
    process.env.HAIKU_FALLBACK_ENABLED = 'false';
    const localFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/messages')) {
        return Response.json({ messages: [{ id: 'wamid.' + randomUUID() }] });
      }
      if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize') {
        const body = JSON.parse(String(options?.body));
        pending.set(body.reference, { amount: Number(body.amount), subaccount: body.subaccount, metadata: body.metadata });
        return Response.json({ status: true, data: {
          reference: body.reference, authorization_url: 'https://checkout.invalid/' + body.reference, access_code: 'fixture',
        } });
      }
      if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const charge = pending.get(reference)!;
        const transaction = charged.get(reference)!;
        const body = { id: transaction, reference, domain: 'test', amount: charge.amount, currency: 'GHS', status: 'success',
          paid_at: new Date().toISOString(), channel: 'card', subaccount: { subaccount_code: charge.subaccount }, metadata: charge.metadata };
        return new Response(JSON.stringify({ status: true, data: body }).replace('"id":"' + transaction + '"', '"id":' + transaction),
          { headers: { 'Content-Type': 'application/json' } });
      }
      return localFetch(input, options);
    });
    ({ prisma } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    const clients = await import('../src/config/redis.js');
    disconnectRedis = () => {
      for (const client of [clients.redis, clients.redisSubscriber, clients.sseSubscriber, clients.rateLimitRedis]) {
        client.disconnect();
      }
    };
    app = await (await import('../src/app.js')).createApp();
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
      await prisma?.$disconnect();
    } finally {
      disconnectRedis?.();
      vi.unstubAllGlobals();
    }
  });

  async function shop(patch: { depositPercent?: number; releaseOnDeposit?: boolean; allowFollowup?: boolean } = {}) {
    const phone = randomUUID();
    const business = await prisma.business.create({ data: {
      name: 'Batch 3 synthetic shop', ownerName: 'Fixture', aiAssistMode: 'OFF', waPhoneNumberId: phone,
      waAccessToken: 'synthetic-local-test-token', paystackSubaccountCode: 'ACCT_' + randomUUID(), receiptsEnabled: false,
    } });
    await prisma.$executeRaw`
      UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(Date.now() - 60_000)}
      WHERE "phoneNumberId" = ${phone} AND "businessId" = ${business.id} AND "endedAt" IS NULL
    `;
    const customer = await prisma.customer.create({ data: { businessId: business.id, waNumber: '233201234567' } });
    const headers = { authorization: 'Bearer ' + sign({ businessId: business.id, plan: 'BUSINESS' }, '15m') };
    const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: Record<string, unknown>) => app.inject({
      method, url: '/api/v1' + path, headers, ...(payload ? { payload } : {}),
    });
    const workflow = await api('PUT', '/workflow-settings', { profile: 'ONLINE_RETAIL', enabled: true, supportMode: 'VERIFIED_STATUS', revision: 0 });
    expect(workflow.statusCode, workflow.body).toBe(200);
    const policy = await api('PUT', '/commerce/policy', { enabled: true, allowPickup: true, allowDelivery: true,
      quoteMinutes: 30, invoiceDays: 7, depositPercent: 0, releaseOnDeposit: false, revision: 0, ...patch });
    expect(policy.statusCode, policy.body).toBe(200);
    return { business, customer, phone, api };
  }

  it('preserves a seeded Batch 2 approval and its pinned workflow during migration', async () => {
    const upgradeUrl = process.env.G1_03_UPGRADE_DATABASE_URL;
    if (!upgradeUrl || new URL(upgradeUrl).hostname !== '127.0.0.1') throw new Error('Use the seeded loopback upgrade fixture');
    const upgrade = new PrismaClient({ datasourceUrl: upgradeUrl });
    try {
      const preserved = await upgrade.workflow.findUniqueOrThrow({ where: { id: 'a4a66288-75dd-4276-929d-e38ba5e47c73' },
        include: { evidence: true, approval: true } });
      expect(preserved).toMatchObject({ version: 1, state: 'WAITING_OWNER_APPROVAL', approval: { definitionVersion: 1, decision: null },
        evidence: [{ eventType: 'APPROVAL_REQUESTED' }] });
      expect(await upgrade.commercePolicy.findUnique({ where: { businessId: preserved.businessId } })).toBeNull();
    } finally {
      await upgrade.$disconnect();
    }
  });

  it('serializes last-unit holds, rejects a foreign SKU and releases an expired hold', async () => {
    const a = await shop();
    const b = await shop();
    const other = await prisma.customer.create({ data: { businessId: a.business.id, waNumber: '233200088888' } });
    const sku = await prisma.product.create({ data: { businessId: a.business.id, name: 'One unit', sku: 'ONE',
      price: 20, unit: 'piece', stockQuantity: 1 } });
    const quote = (customerId: string, key = randomUUID()) => a.api('POST', '/commerce/quotes', {
      customerId, requestKey: key, deliveryMode: 'PICKUP', items: [{ productId: sku.id, quantity: 1 }],
    });
    const results = await Promise.all([quote(a.customer.id), quote(other.id)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const successful = await prisma.commerceQuote.findFirstOrThrow({ where: { businessId: a.business.id } });
    const replay = await quote(successful.customerId, successful.requestKey);
    expect(replay.json().data.id).toBe(successful.id);
    expect((await b.api('POST', '/commerce/quotes', { customerId: b.customer.id, requestKey: randomUUID(),
      deliveryMode: 'PICKUP', items: [{ productId: sku.id, quantity: 1 }] })).statusCode).toBe(409);
    expect((await a.api('PATCH', '/products/' + sku.id, { stockQuantity: 0 })).statusCode).toBe(409);
    await prisma.commerceQuote.update({ where: { id: successful.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const { recoverWorkflows } = await import('../src/modules/workflows/workflow.worker.js');
    await recoverWorkflows();
    expect(await prisma.commerceQuote.findUnique({ where: { id: successful.id } })).toMatchObject({ state: 'EXPIRED' });
    expect((await quote(other.id)).statusCode).toBe(201);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: sku.id } })).stockQuantity.toString()).toBe('1');
  });

  it('rejects delivery users and stale roles at the commerce authorization boundaries', async () => {
    const fixture = await shop();
    const businessId = fixture.business.id;
    const rider = await prisma.staff.create({ data: { businessId, role: 'DELIVERY', name: 'Fixture rider', phone: '233208555551' } });
    const manager = await prisma.staff.create({ data: { businessId, role: 'MANAGER', name: 'Fixture manager', phone: '233208555552' } });
    const bearer = (staffId: string, role: 'DELIVERY' | 'MANAGER' | 'OPERATIONS') => ({
      authorization: 'Bearer ' + sign({ businessId, staffId, role, plan: 'BUSINESS' }, '15m'),
    });
    const get = (path: string, headers: ReturnType<typeof bearer>) => app.inject({ url: '/api/v1/commerce/' + path, headers });
    for (const route of ['quotes', 'invoices', 'cases']) expect((await get(route, bearer(rider.id, 'DELIVERY'))).statusCode).toBe(403);
    expect((await get('cases', bearer(manager.id, 'MANAGER'))).statusCode).toBe(200);
    await prisma.staff.update({ where: { id: manager.id }, data: { role: 'OPERATIONS' } });
    expect((await get('cases', bearer(manager.id, 'MANAGER'))).statusCode).toBe(403);
    expect((await get('cases', bearer(manager.id, 'OPERATIONS'))).statusCode).toBe(200);
  });

  it('runs signed variant retail, deposits, shipment evidence and care through the shared engine', async () => {
    const fixture = await shop({ depositPercent: 25, allowFollowup: true });
    const foreign = await shop();
    const { intentClassifierWorker } = await import('../src/workers/intent-classifier.worker.js');
    const { openTextReceiptQueue, dispatchTextReceipts } = await import('../src/workers/text-receipt.worker.js');
    const { outboundWorker, startDurableOutboundRecovery } = await import('../src/workers/outbound.worker.js');
    const { startFulfillmentRecovery } = await import('../src/workers/fulfillment-recovery.js');
    const { startWorkflowRecovery } = await import('../src/modules/workflows/workflow.worker.js');
    const { drainPaystackReceipts } = await import('../src/modules/payments/paystack-settlement.js');
    const workers = [intentClassifierWorker, outboundWorker];
    const producer = openTextReceiptQueue();
    const running = workers.map((worker) => worker.run());
    const stops = [startDurableOutboundRecovery(), startFulfillmentRecovery(), startWorkflowRecovery()];
    const scope = { businessId: fixture.business.id, customerId: fixture.customer.id };
    const workflowFor = (sourceId: string) => prisma.workflow.findUnique({ where: { businessId_sourceId: { businessId: scope.businessId, sourceId } } });

    async function signedMeta(value: Record<string, unknown>) {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
        value: { metadata: { phone_number_id: fixture.phone }, ...value },
      }] }] });
      const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
        'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex'),
      } });
      expect(response.statusCode, response.body).toBe(200);
    }

    async function inbound(body: string) {
      const id = 'wamid.' + randomUUID();
      const message = { id, from: fixture.customer.waNumber, type: 'text', text: { body }, timestamp: String(Math.floor(Date.now() / 1000)) };
      await signedMeta({ messages: [message] });
      await signedMeta({ messages: [message] });
      await dispatchTextReceipts(producer.enqueue, new Date(), scope.businessId);
      const receipt = await prisma.whatsAppTextReceipt.findUniqueOrThrow({
        where: { phoneNumberId_waMessageId: { phoneNumberId: fixture.phone, waMessageId: id } },
      });
      expect(receipt).toMatchObject({ status: 'COMPLETED', businessId: scope.businessId, messageId: expect.any(String) });
      return receipt.messageId!;
    }

    async function settle(reference: string, transactionId: string) {
      charged.set(reference, transactionId);
      const payload = JSON.stringify({ event: 'charge.success', data: { id: transactionId, reference, amount: pending.get(reference)!.amount,
        domain: 'test', currency: 'GHS', status: 'success', paid_at: new Date().toISOString() } }).replace('"id":"' + transactionId + '"', '"id":' + transactionId);
      const submit = () => app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload, headers: {
        'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', paystackSecret).update(payload).digest('hex'),
      } });
      for (const response of await Promise.all([submit(), submit()])) expect(response.statusCode, response.body).toBe(200);
      await drainPaystackReceipts(scope.businessId);
    }

    async function delivery(eventKey: string) {
      const where = { businessId_eventKey: { businessId: scope.businessId, eventKey } };
      await expect.poll(async () => (await prisma.whatsAppSend.findUnique({ where }))?.state,
        { timeout: 40_000, interval: 300 }).toBe('PROVIDER_ACCEPTED');
      const sent = await prisma.whatsAppSend.findUniqueOrThrow({ where });
      await signedMeta({ statuses: [{ id: sent.providerMessageId, status: 'delivered', recipient_id: fixture.customer.waNumber,
        timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: sent.id }] });
    }

    try {
      await producer.ready();
      const { api } = fixture;
      const parent = await api('POST', '/products', { name: 'Rice', sku: 'RICE-BASE', unit: 'bag', price: 20 });
      expect(parent.statusCode, parent.body).toBe(201);
      const blue = await api('POST', '/products', { name: 'Rice', sku: 'RICE-BLUE', unit: 'bag', price: 30,
        stockQuantity: 4, variantOfId: parent.json().data.id, variantLabel: 'Blue', tiers: [{ minQuantity: 2, percentOff: 10 }] });
      expect(blue.statusCode, blue.body).toBe(201);
      const bag = await api('POST', '/products', { name: 'Bag', sku: 'BAG', unit: 'piece', price: 6, stockQuantity: 3 });
      expect(bag.statusCode, bag.body).toBe(201);

      const sourceId = await inbound('QUOTE RICE-BLUE*2, BAG*1 DELIVERY: Synthetic street, Accra');
      await expect.poll(async () => (await workflowFor(sourceId))?.reason, { timeout: 30_000 }).toBe('QUOTE_AWAITS_ACCEPTANCE');
      const quote = await prisma.commerceQuote.findFirstOrThrow({ where: { ...scope, sourceId } });
      expect(quote.total.toFixed(2)).toBe('60.00');
      await delivery('commerce-quote-' + quote.id);
      await prisma.$executeRawUnsafe('CREATE SEQUENCE commerce_test_invoice_failure_seq');
      await prisma.$executeRawUnsafe(`CREATE FUNCTION commerce_test_invoice_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('commerce_test_invoice_failure_seq'); RAISE EXCEPTION 'synthetic invoice write failure'; END; $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER commerce_test_invoice_failure BEFORE INSERT ON commerce_invoices
        FOR EACH ROW EXECUTE FUNCTION commerce_test_invoice_failure()`);
      try {
        await inbound('ACCEPT ' + quote.id);
        await expect.poll(async () => (await prisma.$queryRaw<{ is_called: boolean }[]>`
          SELECT is_called FROM commerce_test_invoice_failure_seq
        `)[0]?.is_called, { timeout: 25_000 }).toBe(true);
        expect(await prisma.commerceQuote.findUnique({ where: { id: quote.id } })).toMatchObject({ state: 'OFFERED', orderId: null });
        expect(await prisma.order.count({ where: scope })).toBe(0);
        expect((await prisma.product.findUniqueOrThrow({ where: { id: blue.json().data.id } })).stockQuantity.toString()).toBe('4');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER commerce_test_invoice_failure ON commerce_invoices');
        await prisma.$executeRawUnsafe('DROP FUNCTION commerce_test_invoice_failure()');
        await prisma.$executeRawUnsafe('DROP SEQUENCE commerce_test_invoice_failure_seq');
      }
      await expect.poll(async () => (await prisma.commerceQuote.findUnique({ where: { id: quote.id } }))?.orderId,
        { timeout: 30_000 }).toEqual(expect.any(String));
      const accepted = await prisma.commerceQuote.findUniqueOrThrow({ where: { id: quote.id } });
      const orderId = accepted.orderId!;
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const invoice = await prisma.commerceInvoice.findUniqueOrThrow({ where: { orderId } });
      expect(invoice.deposit.toFixed(2)).toBe('15.00');
      expect(order.status).toBe('CONFIRMED');
      expect((await prisma.product.findUniqueOrThrow({ where: { id: blue.json().data.id } })).stockQuantity.toString()).toBe('2');
      expect(await prisma.stockMovement.count({ where: { businessId: scope.businessId, orderId, type: 'SALE' } })).toBe(2);
      expect((await foreign.api('GET', '/commerce/invoices/' + invoice.id)).statusCode).toBe(404);
      await delivery('commerce-invoice-' + invoice.id);
      expect((await api('POST', '/payments/links', { customerId: scope.customerId, orderId, amount: 16, send: false })).statusCode).toBe(409);
      const deposit = await api('POST', '/commerce/invoices/' + invoice.id + '/checkout', { send: false });
      expect(deposit.statusCode, deposit.body).toBe(200);
      await settle(deposit.json().data.reference, '840001');
      expect((await api('GET', '/commerce/invoices/' + invoice.id)).json().data).toMatchObject({ state: 'PARTIALLY_PAID', due: '45' });
      expect((await api('PATCH', '/orders/' + orderId + '/status', { status: 'PROCESSING' })).statusCode).toBe(409);
      const balance = await api('POST', '/commerce/invoices/' + invoice.id + '/checkout', { send: false });
      expect(balance.statusCode, balance.body).toBe(200);
      await settle(balance.json().data.reference, '840002');
      await expect.poll(() => prisma.commercePreparation.count({ where: { invoiceId: invoice.id, businessId: scope.businessId } }),
        { timeout: 25_000 }).toBe(1);
      expect(await prisma.payment.count({ where: { orderId, businessId: scope.businessId } })).toBe(2);
      expect((await api('GET', '/commerce/invoices/' + invoice.id)).json().data).toMatchObject({ state: 'VERIFIED_PAID', due: '0' });
      const processing = await api('PATCH', '/orders/' + orderId + '/status', { status: 'PROCESSING' });
      expect(processing.statusCode, processing.body).toBe(200);
      expect((await api('POST', '/orders/' + orderId + '/dispatch', {})).statusCode).toBe(409);
      expect((await api('PATCH', '/commerce/orders/' + orderId + '/preparation', { state: 'READY', assignedStaffId: null })).statusCode).toBe(200);
      expect((await api('POST', '/orders/' + orderId + '/dispatch', { courier: 'Synthetic courier' })).statusCode).toBe(200);
      expect((await api('POST', '/orders/' + orderId + '/dispatch/delivered')).statusCode).toBe(200);
      await delivery('order-status-' + orderId + '-FULFILLED');
      await expect.poll(async () => (await workflowFor(sourceId))?.state, { timeout: 30_000 }).toBe('COMPLETED');

      const complaint = await inbound('Wrong item for ' + order.referenceNumber);
      await expect.poll(async () => (await workflowFor(complaint))?.reason, { timeout: 25_000 }).toBe('CUSTOMER_CASE_OPEN');
      const item = await prisma.commerceCase.findFirstOrThrow({ where: { ...scope, sourceId: complaint } });
      expect(item).toMatchObject({ orderId, state: 'OPEN', kind: 'COMPLAINT' });
      expect((await foreign.api('GET', '/commerce/cases/' + item.id)).statusCode).toBe(404);
      expect((await api('PATCH', '/commerce/cases/' + item.id, { state: 'RESOLVED', staffId: null, revision: 0 })).statusCode).toBe(409);
      const confirmation = await inbound('RESOLVED ' + item.id);
      const resolveCase = () => api('PATCH', '/commerce/cases/' + item.id, {
        state: 'RESOLVED', staffId: null, revision: 0, resolution: 'CUSTOMER_CONFIRMED_RESOLUTION', evidenceMessageId: confirmation,
      });
      expect((await Promise.all([resolveCase(), resolveCase()])).map((result) => result.statusCode).sort()).toEqual([200, 409]);
      await expect.poll(async () => (await workflowFor(complaint))?.state, { timeout: 25_000 }).toBe('COMPLETED');

      expect((await api('POST', '/commerce/orders/' + orderId + '/followup', {})).statusCode).toBe(404);
      const optIn = await inbound('START ORDER FOLLOWUPS');
      await expect.poll(async () => (await workflowFor(optIn))?.state, { timeout: 25_000 }).toBe('COMPLETED');
      expect((await api('POST', '/commerce/orders/' + orderId + '/followup', {})).statusCode).toBe(200);
      expect((await api('POST', '/commerce/orders/' + orderId + '/followup', {})).statusCode).toBe(200);
      await delivery('commerce-followup-' + orderId);
      expect(await prisma.whatsAppSend.count({ where: { businessId: scope.businessId, eventKey: 'commerce-followup-' + orderId } })).toBe(1);
      await inbound('STOP ORDER FOLLOWUPS');
      expect((await api('POST', '/commerce/orders/' + orderId + '/followup', {})).statusCode).toBe(404);

      const custom = await api('POST', '/products', { name: 'Custom sign', sku: 'CUSTOM', unit: 'piece', price: 100,
        commerceMode: 'MADE_TO_ORDER' });
      expect(custom.statusCode, custom.body).toBe(201);
      const specification = await inbound('QUOTE CUSTOM*1 PICKUP | SPEC: Blue lettering on a 20 cm base');
      await expect.poll(async () => (await workflowFor(specification))?.reason, { timeout: 25_000 }).toBe('CUSTOM_QUOTE_REVIEW');
      const draft = await prisma.commerceQuote.findFirstOrThrow({ where: { ...scope, sourceId: specification } });
      expect(draft).toMatchObject({ state: 'DRAFT', specification: 'Blue lettering on a 20 cm base' });
      expect((await api('POST', '/commerce/quotes/' + draft.id + '/decision', { decision: 'OFFER' })).statusCode).toBe(200);
      await delivery('commerce-quote-' + draft.id);
      await inbound('ACCEPT ' + draft.id);
      await expect.poll(async () => (await prisma.commerceQuote.findUnique({ where: { id: draft.id } }))?.orderId,
        { timeout: 25_000 }).toEqual(expect.any(String));
      const customOrder = (await prisma.commerceQuote.findUniqueOrThrow({ where: { id: draft.id } })).orderId!;
      const customInvoice = await prisma.commerceInvoice.findUniqueOrThrow({ where: { orderId: customOrder } });
      const customCheckout = await api('POST', '/commerce/invoices/' + customInvoice.id + '/checkout', { send: false });
      expect(customCheckout.statusCode, customCheckout.body).toBe(200);
      await settle(customCheckout.json().data.reference, '840003');
      const customBalance = await api('POST', '/commerce/invoices/' + customInvoice.id + '/checkout', { send: false });
      expect(customBalance.statusCode, customBalance.body).toBe(200);
      await settle(customBalance.json().data.reference, '840004');
      await expect.poll(() => prisma.commercePreparation.findUnique({ where: { invoiceId: customInvoice.id } }),
        { timeout: 25_000 }).toMatchObject({ state: 'PREPARING', madeToOrder: true });
      expect(await prisma.stockMovement.count({ where: { orderId: customOrder } })).toBe(0);
      expect((await api('PATCH', '/orders/' + customOrder + '/status', { status: 'PROCESSING' })).statusCode).toBe(200);
      expect((await api('PATCH', '/orders/' + customOrder + '/status', { status: 'FULFILLED' })).statusCode).toBe(409);
      expect((await api('PATCH', '/commerce/orders/' + customOrder + '/preparation', { state: 'READY', assignedStaffId: null })).statusCode).toBe(200);
      expect((await api('PATCH', '/orders/' + customOrder + '/status', { status: 'FULFILLED' })).statusCode).toBe(200);
      expect(await prisma.commercePreparation.findUnique({ where: { invoiceId: customInvoice.id } })).toMatchObject({ state: 'COLLECTED' });
      await delivery('order-status-' + customOrder + '-FULFILLED');
      await expect.poll(async () => (await workflowFor(specification))?.state, { timeout: 25_000 }).toBe('COMPLETED');

      const cancelQuoteSource = await inbound('QUOTE BAG*1 PICKUP');
      await expect.poll(async () => (await workflowFor(cancelQuoteSource))?.reason, { timeout: 25_000 }).toBe('QUOTE_AWAITS_ACCEPTANCE');
      const cancelQuote = await prisma.commerceQuote.findFirstOrThrow({ where: { ...scope, sourceId: cancelQuoteSource } });
      await inbound('ACCEPT ' + cancelQuote.id);
      await expect.poll(async () => (await prisma.commerceQuote.findUnique({ where: { id: cancelQuote.id } }))?.orderId,
        { timeout: 25_000 }).toEqual(expect.any(String));
      const cancelOrderId = (await prisma.commerceQuote.findUniqueOrThrow({ where: { id: cancelQuote.id } })).orderId!;
      const cancelOrder = await prisma.order.findUniqueOrThrow({ where: { id: cancelOrderId } });
      const cancelledInvoice = await prisma.commerceInvoice.findUniqueOrThrow({ where: { orderId: cancelOrderId } });
      const cancelDeposit = await api('POST', '/commerce/invoices/' + cancelledInvoice.id + '/checkout', { send: false });
      expect(cancelDeposit.statusCode, cancelDeposit.body).toBe(200);
      await settle(cancelDeposit.json().data.reference, '840005');
      const cancelBalance = await api('POST', '/commerce/invoices/' + cancelledInvoice.id + '/checkout', { send: false });
      expect(cancelBalance.statusCode, cancelBalance.body).toBe(200);
      await settle(cancelBalance.json().data.reference, '840006');
      const cancellation = await inbound('Cancel order ' + cancelOrder.referenceNumber);
      await expect.poll(async () => (await workflowFor(cancellation))?.reason, { timeout: 25_000 }).toBe('CUSTOMER_CASE_OPEN');
      const cancellationCase = await prisma.commerceCase.findFirstOrThrow({ where: { ...scope, sourceId: cancellation } });
      expect(cancellationCase).toMatchObject({ state: 'OPEN', orderId: cancelOrderId, kind: 'CANCELLATION' });
      const cancel = () => api('PATCH', '/orders/' + cancelOrderId + '/status', { status: 'CANCELLED', note: 'Customer requested cancellation' });
      const { releasePreparation } = await import('../src/modules/commerce/commerce.fulfillment.js');
      const [cancelled] = await Promise.all([cancel(), prisma.$transaction((tx) => releasePreparation(tx, scope.businessId, cancelOrderId))]);
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect((await cancel()).statusCode).toBe(200);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: bag.json().data.id } })).stockQuantity.toString()).toBe('2');
      expect(await prisma.stockMovement.count({ where: { businessId: scope.businessId, orderId: cancelOrderId } })).toBe(2);
      expect(await prisma.commercePreparation.count({ where: { invoiceId: cancelledInvoice.id, state: { not: 'CANCELLED' } } })).toBe(0);
      expect(await prisma.payment.count({ where: { businessId: scope.businessId, orderId: cancelOrderId } })).toBe(2);
      expect((await api('POST', '/commerce/invoices/' + cancelledInvoice.id + '/checkout', { send: false })).statusCode).toBe(409);
      expect((await api('PATCH', '/commerce/cases/' + cancellationCase.id, {
        state: 'RESOLVED', revision: 0, staffId: null, resolution: 'CANCELLATION_CONFIRMED',
      })).statusCode).toBe(200);

      const staleSource = await inbound('QUOTE BAG*1 PICKUP');
      await expect.poll(async () => (await workflowFor(staleSource))?.reason, { timeout: 25_000 }).toBe('QUOTE_AWAITS_ACCEPTANCE');
      const staleQuote = await prisma.commerceQuote.findFirstOrThrow({ where: { ...scope, sourceId: staleSource } });
      expect((await api('PATCH', '/products/' + bag.json().data.id, { price: 7 })).statusCode).toBe(200);
      const staleAcceptance = await inbound('ACCEPT ' + staleQuote.id);
      await expect.poll(async () => (await workflowFor(staleAcceptance))?.state, { timeout: 25_000 }).toBe('REVIEW_REQUIRED');
      expect((await prisma.commerceQuote.findUniqueOrThrow({ where: { id: staleQuote.id } })).orderId).toBeNull();

      const returnSource = await inbound('Return order ' + order.referenceNumber);
      await expect.poll(async () => (await workflowFor(returnSource))?.reason, { timeout: 25_000 }).toBe('CUSTOMER_CASE_OPEN');
      const returned = await prisma.commerceCase.findFirstOrThrow({ where: { ...scope, sourceId: returnSource } });
      expect(returned).toMatchObject({ state: 'OPEN', orderId, kind: 'RETURN' });
      const returnPath = '/commerce/cases/' + returned.id;
      expect((await foreign.api('POST', returnPath + '/receive-return', { revision: 0 })).statusCode).toBe(404);
      expect((await api('GET', returnPath)).json().data.canReceiveReturn).toBe(true);
      const receive = () => api('POST', returnPath + '/receive-return', { revision: 0 });
      for (const result of await Promise.all([receive(), receive()])) expect(result.statusCode, result.body).toBe(200);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: blue.json().data.id } })).stockQuantity.toString()).toBe('4');
      expect(await prisma.stockMovement.count({ where: { businessId: scope.businessId, orderId } })).toBe(4);
      expect(await prisma.stockMovement.count({ where: { businessId: scope.businessId, orderId, type: 'RETURN', note: 'Commerce return received' } })).toBe(2);
      expect(await prisma.payment.count({ where: { orderId, businessId: scope.businessId } })).toBe(2);
      expect(await prisma.commerceCase.findUnique({ where: { id: returned.id } })).toMatchObject({
        state: 'WAITING', revision: 1, resolution: 'RETURN_RECEIVED_TO_STOCK',
      });
      expect((await api('GET', returnPath)).json().data.canReceiveReturn).toBe(false);
    } finally {
      await Promise.all(stops.map((stop) => stop()));
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(running);
      await producer.close();
    }
  }, 300_000);
});
