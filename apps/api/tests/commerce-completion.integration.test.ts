import { createHmac, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const db = process.env.G1_BATCH_DATABASE_URL;
const redis = process.env.G1_BATCH_REDIS_URL;
const fixtureOnly = db || redis ? describe : describe.skip;
const paySecret = 'sk_test_commerce_completion_fixture';
const metaSecret = 'commerce-completion-synthetic-signature';

fixtureOnly('Batch 3 completion with PostgreSQL, BullMQ and signed providers', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let closeClients: () => void;
  let transactionId = 90001;
  let sendMode = 'OK';
  let templateStatus = 'APPROVED';
  const provider = new Map<string, { amount: number; subaccount: string; metadata: Record<string, string> }>();
  const settled = new Map<string, number>();
  const paidAtByTransaction = new Map<number, string>();
  const providerMessages: Record<string, unknown>[] = [];

  function verification(reference: string, id: number) {
    const charge = provider.get(reference)!;
    const paidAt = paidAtByTransaction.get(id) ?? new Date().toISOString();
    paidAtByTransaction.set(id, paidAt);
    return { id, reference, status: 'success', amount: charge.amount, currency: 'GHS', domain: 'test',
      paid_at: paidAt, channel: 'card', subaccount: { subaccount_code: charge.subaccount }, metadata: charge.metadata };
  }

  beforeAll(async () => {
    if (![db, redis].every((url) => url && new URL(url).hostname === '127.0.0.1')) throw new Error('Use disposable IPv4 fixtures');
    process.env.DATABASE_URL = db;
    const cache = new URL(redis!);
    cache.pathname = '/10';
    process.env.REDIS_URL = cache.href;
    process.env.PAYSTACK_SECRET_KEY = paySecret;
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_commerce_completion_fixture';
    process.env.META_WEBHOOK_SECRET = metaSecret;
    const local = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize') {
        const body = JSON.parse(String(options?.body));
        expect(provider.has(body.reference)).toBe(false);
        provider.set(body.reference, { ...body, metadata: JSON.parse(body.metadata) });
        return Response.json({ status: true, data: { reference: body.reference, authorization_url: 'https://checkout.invalid/' + body.reference, access_code: 'fixture' } });
      }
      if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/')) {
        const reference = url.pathname.split('/').at(-1)!;
        const id = settled.get(reference);
        return id ? Response.json({ status: true, data: verification(reference, id) }) : new Response(null, { status: 503 });
      }
      if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/message_templates')) return Response.json({ data: [{
        name: 'fixture_reminder', language: 'en', status: templateStatus, category: 'UTILITY', components: [{ type: 'BODY',
          text: (await import('../src/modules/commerce/commerce.reminders.js')).PAYMENT_REMINDER_TEMPLATE }],
      }] });
      if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/messages')) {
        providerMessages.push(JSON.parse(String(options?.body)));
        if (sendMode === 'TIMEOUT') throw new Error('Synthetic transport interrupted');
        if (sendMode === 'RATE_LIMIT') return Response.json({ error: { code: 130429, message: 'Synthetic capacity limit' } }, { status: 429 });
        return Response.json({ messages: [{ id: 'wamid.' + randomUUID() }] });
      }
      return local(input, options);
    });
    ({ prisma } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    const connections = await import('../src/config/redis.js');
    await connections.connectRedis();
    closeClients = () => [connections.redis, connections.redisSubscriber, connections.sseSubscriber, connections.rateLimitRedis]
      .forEach((client) => client.disconnect());
    app = await (await import('../src/app.js')).createApp();
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); await prisma?.$disconnect(); }
    finally { closeClients?.(); vi.unstubAllGlobals(); }
  });

  async function createShop() {
    const business = await prisma.business.create({ data: { name: 'Closure synthetic shop', ownerName: 'Fixture',
      waPhoneNumberId: randomUUID(), waWabaId: '100020003000', waAccessToken: 'synthetic-test-token',
      paystackSubaccountCode: 'ACCT_' + randomUUID(), receiptsEnabled: true } });
    const customer = await prisma.customer.create({ data: { businessId: business.id, name: 'Fixture customer',
      waNumber: '233200010001', lastInboundAt: new Date() } });
    const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: Record<string, unknown>, staff?: { id: string; role: 'MANAGER' | 'DELIVERY' | 'OPERATIONS' }) => app.inject({
      method, url: '/api/v1' + path, ...(payload ? { payload } : {}), headers: {
        authorization: 'Bearer ' + sign({ businessId: business.id, plan: 'BUSINESS',
          ...(staff ? { staffId: staff.id, role: staff.role } : {}) }, '15m'),
      },
    });
    const scope = { businessId: business.id, customerId: customer.id };
    const invoice = async (minor: number, customerId = customer.id) => {
      const response = await api('POST', '/commerce/invoices', { customerId, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        lines: [{ description: 'Approved fixture item', unitMinor: minor, quantity: 1 }] });
      expect(response.statusCode, response.body).toBe(201);
      const result = response.json().data as { id: string; reference: string };
      const issue = await api('POST', '/commerce/invoices/' + result.id + '/decision', { action: 'ISSUE' });
      expect(issue.statusCode, issue.body).toBe(200);
      return result;
    };
    const view = async (id: string) => (await api('GET', '/commerce/invoices/' + id)).json().data;
    const checkout = (id: string, amountMinor?: number, version?: string) => api('POST', '/commerce/invoices/' + id + '/checkout',
      { ...(amountMinor ? { amountMinor } : {}), ...(version ? { checkoutVersion: version } : {}) });
    return { business, customer, api, scope, invoice, view, checkout };
  }

  async function seedOrder(fixture: Awaited<ReturnType<typeof createShop>>, status: 'CONFIRMED' | 'FULFILLED', mixed = false, deposit = 0) {
    const { scope } = fixture;
    const item = await prisma.product.create({ data: { businessId: scope.businessId, name: 'Tracked fixture item',
      sku: 'T-' + randomUUID(), unit: 'piece', price: 25, stockQuantity: 2, commerceMode: 'TRACKED' } });
    const custom = mixed ? await prisma.product.create({ data: { businessId: scope.businessId, name: 'Custom fixture item',
      sku: 'C-' + randomUUID(), unit: 'piece', price: 20, stockQuantity: 0, commerceMode: 'MADE_TO_ORDER' } }) : null;
    const source = await prisma.message.create({ data: { ...scope, waMessageId: 'wamid.' + randomUUID(), direction: 'INBOUND',
      type: 'TEXT', body: 'Synthetic customer-confirmed order', processed: true } });
    const total = mixed ? 70 : 50;
    const order = await prisma.order.create({ data: { ...scope, status, inboundSourceMessageId: source.id,
      referenceNumber: 'FD-' + randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(), rawMessage: 'Synthetic retail order',
      totalAmount: total, stockDeducted: true, items: { create: [
        { productId: item.id, description: item.name, quantity: 2, matched: true, unitPrice: 25, subtotal: 50 },
        ...(custom ? [{ productId: custom.id, description: custom.name, quantity: 1, matched: true, unitPrice: 20, subtotal: 20 }] : []),
      ] } }, include: { items: true } });
    await prisma.commerceQuote.create({ data: { ...scope, orderId: order.id, requestKey: randomUUID(), requestHash: randomUUID(), state: 'ACCEPTED',
      deliveryMode: 'PICKUP', total, policyRevision: 1, expiresAt: new Date(Date.now() + 3_600_000),
      lines: { create: [{ productId: item.id, itemName: item.name, quantity: 2, productMode: 'TRACKED', listPrice: 25, unitPrice: 25 },
        ...(custom ? [{ productId: custom.id, itemName: custom.name, quantity: 1, productMode: 'MADE_TO_ORDER' as const, listPrice: 20, unitPrice: 20 }] : [])] },
    } });
    const invoice = await prisma.commerceInvoice.create({ data: { ...scope, orderId: order.id, reference: 'INV-' + order.referenceNumber,
      total, deposit, releaseThreshold: total, dueAt: new Date(Date.now() + 86_400_000), receiptLines: [] } });
    return { order, invoice, source, item, custom };
  }

  async function signedPaystack(reference: string, id: number) {
    settled.set(reference, id);
    const payload = JSON.stringify({ event: 'charge.success', data: verification(reference, id) });
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload, headers: {
      'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', paySecret).update(payload).digest('hex'),
    } });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function settle(reference: string, businessId: string) {
    const { drainPaystackReceipts } = await import('../src/modules/payments/paystack-settlement.js');
    const id = transactionId++;
    await Promise.all([signedPaystack(reference, id), signedPaystack(reference, id)]);
    await Promise.all([drainPaystackReceipts(businessId), drainPaystackReceipts(businessId)]);
  }

  async function signedDelivery(phone: string, recipient: string, sendId: string, providerMessageId: string) {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: phone }, statuses: [{ id: providerMessageId, status: 'delivered', recipient_id: recipient,
        timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: sendId }],
    } }] }] });
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
      'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex'),
    } });
    expect(response.statusCode, response.body).toBe(200);
  }

  it('preserves prior Batch 3 invoices, settled gateway identities and full-return records without reallocating history', async () => {
    const prior = process.env.G1_B3_UPGRADE_DATABASE_URL;
    if (!prior || new URL(prior).hostname !== '127.0.0.1') throw new Error('Use the prior Batch 3 upgrade fixture');
    const { PrismaClient } = await import('@prisma/client');
    const historical = new PrismaClient({ datasourceUrl: prior });
    try {
      const { invoiceView } = await import('../src/modules/commerce/commerce.invoices.js');
      const invoice = await invoiceView(historical, 'b3-legacy-invoice', 'b2-upgrade-shop');
      expect(invoice).toMatchObject({ status: 'ISSUED', orderId: 'b3-legacy-order', state: 'VERIFIED_PAID' });
      expect(invoice.verified.toString()).toBe('40');
      expect(await historical.paymentRequest.findUnique({ where: { id: 'b3-legacy-request' } })).toMatchObject({
        invoiceId: null, paymentId: 'b3-legacy-payment', status: 'PAID',
      });
      expect(await historical.paystackSettlement.findUnique({ where: { id: 'b3-legacy-settlement' } })).toMatchObject({
        transactionId: '8765001', receiptId: 'b3-legacy-receipt', paymentId: 'b3-legacy-payment',
      });
      expect(await historical.commerceCaseEvent.findFirst({ where: { caseId: 'b3-legacy-return' } })).toMatchObject({ resolution: 'RETURN_RECEIVED_TO_STOCK', revision: 1 });
      expect(await historical.stockMovement.count({ where: { orderId: 'b3-legacy-order', type: 'RETURN' } })).toBe(1);
    } finally { await historical.$disconnect(); }
  });

  it('allocates concurrent signed settlements to exact standalone invoices and preserves unallocated and cancelled history', async () => {
    const first = await createShop();
    const foreign = await createShop();
    const other = await prisma.customer.create({ data: { businessId: first.business.id, name: 'Other customer', waNumber: '233209990124' } });
    const [a, b, c] = await Promise.all([first.invoice(9000), first.invoice(9000), first.invoice(4000, other.id)]);
    expect((await foreign.api('GET', '/commerce/invoices/' + a.id)).statusCode).toBe(404);
    expect((await foreign.checkout(a.id)).statusCode).toBe(404);
    const rider = await prisma.staff.create({ data: { businessId: first.business.id, name: 'Fixture rider', phone: '233222009812', role: 'DELIVERY' } });
    expect((await first.api('GET', '/commerce/invoices/' + a.id, undefined, { id: rider.id, role: 'DELIVERY' })).statusCode).toBe(403);
    const manager = await prisma.staff.create({ data: { businessId: first.business.id, name: 'Fixture manager', phone: '233222009813', role: 'MANAGER' } });
    expect((await first.api('GET', '/commerce/invoices/' + a.id, undefined, { id: manager.id, role: 'MANAGER' })).statusCode).toBe(200);
    expect((await first.checkout(randomUUID())).statusCode).toBe(404);
    await prisma.payment.create({ data: { ...first.scope, amount: 40, confidence: 'SELLER_ATTESTED', method: 'CASH' } });
    const view = await first.view(a.id);
    const [partial, duplicate, independent] = await Promise.all([
      first.checkout(a.id, 3000, view.checkoutVersion), first.checkout(a.id, 3000, view.checkoutVersion), first.checkout(b.id, 3000),
    ]);
    for (const response of [partial, duplicate, independent]) expect(response.statusCode, response.body).toBe(200);
    const aRequest = partial.json().data;
    expect(duplicate.json().data.id).toBe(aRequest.id);
    expect(independent.json().data.id).not.toBe(aRequest.id);
    const otherRequest = (await first.checkout(c.id)).json().data;
    await expect(prisma.paymentRequest.update({ where: { id: aRequest.id }, data: { invoiceId: b.id } })).rejects.toThrow();
    await expect(prisma.paymentRequest.update({ where: { id: aRequest.id }, data: { customerId: other.id } })).rejects.toThrow();
    await settle(aRequest.reference, first.business.id);
    expect(await first.view(a.id)).toMatchObject({ state: 'PARTIALLY_PAID', due: '60', paid: '30', verified: '30' });
    expect(await first.view(b.id)).toMatchObject({ due: '90', paid: '0' });
    expect(await first.view(c.id)).toMatchObject({ due: '40', paid: '0' });
    expect((await first.checkout(a.id, 3000, view.checkoutVersion)).statusCode).toBe(409);
    provider.get(otherRequest.reference)!.metadata.flowdeskInvoiceId = b.id;
    await settle(otherRequest.reference, first.business.id);
    expect(await prisma.paystackReceipt.findFirst({ where: { reference: otherRequest.reference } })).toMatchObject({ state: 'REVIEW', reason: 'VERIFIED_RELATIONSHIP_MISMATCH' });
    const balance = (await first.checkout(a.id)).json().data;
    const { drainPaystackReceipts } = await import('../src/modules/payments/paystack-settlement.js');
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fixture_failure_invoice_allocation() RETURNS trigger AS $$ BEGIN
      IF NEW."invoiceId" IS NOT NULL AND NEW.amount = 60 THEN RAISE EXCEPTION 'Synthetic allocation rollback'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER fixture_failure_invoice_allocation BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fixture_failure_invoice_allocation()');
    try {
      await signedPaystack(balance.reference, transactionId++);
      await drainPaystackReceipts(first.business.id);
      expect(await prisma.paystackReceipt.findFirst({ where: { reference: balance.reference } })).toMatchObject({ state: 'WAITING', reason: 'LOCAL_WRITE_FAILED' });
      expect(await prisma.paystackSettlement.count({ where: { requestId: balance.id } })).toBe(0);
      expect(await first.view(a.id)).toMatchObject({ paid: '30', due: '60' });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fixture_failure_invoice_allocation ON payments');
      await prisma.$executeRawUnsafe('DROP FUNCTION fixture_failure_invoice_allocation()');
    }
    await prisma.paystackReceipt.updateMany({ where: { reference: balance.reference, state: 'WAITING' }, data: { nextAttemptAt: new Date(0) } });
    await drainPaystackReceipts(first.business.id);
    expect(await first.view(a.id)).toMatchObject({ state: 'VERIFIED_PAID', due: '0', paid: '90', verified: '90' });
    expect(await prisma.payment.count({ where: { invoiceId: a.id, confidence: 'GATEWAY_CONFIRMED' } })).toBe(2);
    expect(await prisma.payment.count({ where: { ...first.scope, invoiceId: b.id } })).toBe(0);
    const { drainPaystackNotifications } = await import('../src/workers/paystack-settlement.worker.js');
    await drainPaystackNotifications();
    expect(await prisma.whatsAppSend.count({ where: { businessId: first.business.id, payload: { path: ['body'], string_contains: a.reference } } })).toBeGreaterThan(0);
    expect((await first.api('POST', '/commerce/invoices/' + a.id + '/decision', { action: 'CANCEL' })).statusCode).toBe(200);
    expect(await first.view(a.id)).toMatchObject({ state: 'CANCELLED', paid: '90' });
    expect((await first.checkout(a.id)).statusCode).toBe(409);
    const adjustment = await first.api('POST', `/commerce/invoices/${a.id}/adjustments`, { amountMinor: 1000, reference: 'fixture-bank-proof',
      reason: 'Owner attestation of a recorded reversal', requestKey: randomUUID() });
    expect(adjustment.statusCode, adjustment.body).toBe(200);
    expect(await first.view(a.id)).toMatchObject({ state: 'CANCELLED', paid: '80' });
    expect(await prisma.payment.count({ where: { invoiceId: a.id, direction: 'OUT' } })).toBe(1);
    const archived = await first.invoice(1500, other.id);
    await prisma.customer.update({ where: { id: other.id }, data: { deletedAt: new Date() } });
    expect((await first.checkout(archived.id)).statusCode).toBe(404);
  }, 100_000);

  it('withholds an order checkout link after a legitimate ledger credit makes its amount obsolete', async () => {
    const fixture = await createShop();
    const { order, invoice } = await seedOrder(fixture, 'CONFIRMED');
    const request = await fixture.checkout(invoice.id);
    expect(request.statusCode, request.body).toBe(200);
    expect(await fixture.view(invoice.id)).toMatchObject({ state: 'PAYMENT_PENDING', checkout: { amount: '50' } });
    const { writeManualPayment } = await import('../src/modules/payments/payments.repository.js');
    await writeManualPayment({ customerId: fixture.customer.id, orderId: order.id, amount: 10,
      method: 'CASH', direction: 'IN', attested: true }, fixture.business.id, null);
    expect(await fixture.view(invoice.id)).toMatchObject({ state: 'REVIEW_REQUIRED', checkout: null, due: '40' });
    expect((await fixture.checkout(invoice.id)).statusCode).toBe(409);
    expect(await prisma.paymentRequest.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  async function interrupt(point: string, extraEnv: Record<string, string> = {}, during?: () => Promise<unknown>) {
    const child = fork('tests/fixtures/batch-commerce-recovery.mjs', [point], {
      env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const output: Buffer[] = [];
    child.stderr?.on('data', (value) => output.push(value));
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const hit = await Promise.race([once(child, 'message').then(([message]) => message), exited.then(() => Buffer.concat(output).toString())]);
      expect(hit, String(hit)).toBe(point);
      await during?.();
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      await exited;
    }
  }

  it('hands off one current-balance reminder per slot, checks consent and templates, and recovers evicted jobs', async () => {
    const fixture = await createShop();
    const foreign = await createShop();
    const { recoverCommerceReminders } = await import('../src/modules/commerce/commerce.reminders.js');
    const { recoverDurableOutbound, outboundWorker, processDurableOutbound } = await import('../src/workers/outbound.worker.js');
    const { outboundMessagesQueue } = await import('../src/queues/outbound.queue.js');
    const { businessId } = fixture.scope;
    const now = new Date();
    const policy = { enabled: true, intervalDays: 3, maxReminders: 1, templateName: 'fixture_reminder', templateLanguage: 'en' };
    const lastInboundAt = new Date(+now - 172_800_000);
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { lastInboundAt, reminderConsent: true, reminderConsentAt: lastInboundAt, reminderConsentId: 'fixture-consent' } });
    async function obligation(label: string, overrides: { customerId?: string; status?: 'CANCELLED' | 'ISSUED' } = {}) {
      return prisma.commerceInvoice.create({ data: { ...fixture.scope, ...overrides, reference: 'INV-' + label + '-' + randomUUID(),
        dueAt: new Date(+now - 3_600_000), total: 50, releaseThreshold: 50, receiptLines: [] } });
    }
    const [paid, cancelled, unpaid, changed, omitted, stopped, ambiguous, bounded] = await Promise.all([
      obligation('paid'), obligation('cancelled', { status: 'CANCELLED' }), obligation('unpaid'), obligation('changed'),
      obligation('omitted'), obligation('stopped'), obligation('ambiguous'), obligation('bounded'),
    ]);
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { lastInboundAt: now } });
    const checkoutPaid = (await fixture.checkout(paid.id)).json().data;
    await settle(checkoutPaid.reference, businessId);
    const checkoutPartial = (await fixture.checkout(unpaid.id, 1200)).json().data;
    await settle(checkoutPartial.reference, businessId);
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { lastInboundAt } });
    templateStatus = 'PENDING';
    const unapproved = await fixture.api('PUT', '/commerce/reminders/policy', policy);
    expect(unapproved.statusCode, unapproved.body).toBe(200);
    expect(unapproved.json().data.approvedAt).toBeNull();
    await interrupt('before-reminder-handoff');
    const load = (id: string) => prisma.commerceReminder.findUnique({ where: { invoiceId_sequence: { invoiceId: id, sequence: 1 } }, include: { send: true } });
    expect(await load(unpaid.id)).toMatchObject({ status: 'WAITING', sendId: null });
    await Promise.all([recoverCommerceReminders(), recoverCommerceReminders()]);
    expect(await load(unpaid.id)).toMatchObject({ status: 'WAITING', reason: 'APPROVED_TEMPLATE_REQUIRED', sendId: null });
    expect(await load(paid.id)).toMatchObject({ status: 'CANCELLED', reason: 'INVOICE_PAID' });
    expect(await load(cancelled.id)).toBeNull();
    expect((await foreign.api('GET', `/commerce/invoices/${unpaid.id}/reminders`)).statusCode).toBe(404);
    templateStatus = 'APPROVED';
    await prisma.commerceReminderPolicy.update({ where: { businessId }, data: { templateCheckedAt: new Date(0) } });
    await prisma.commerceReminder.updateMany({ where: { businessId, status: 'WAITING' }, data: { nextCheckAt: new Date(0) } });
    await Promise.all([recoverCommerceReminders(), recoverCommerceReminders()]);
    expect(await prisma.commerceReminderPolicy.findUnique({ where: { businessId } })).toMatchObject({ approvedAt: expect.any(Date) });
    const intent = (await load(unpaid.id))!;
    expect(intent).toMatchObject({ status: 'HANDED_OFF', send: { payload: { template: {
      name: 'fixture_reminder', language: 'en', parameters: [unpaid.reference, '38.00'],
    } } } });
    expect(await prisma.commerceReminder.count({ where: { invoiceId: unpaid.id } })).toBe(1);
    const changedCharge = (await fixture.checkout(changed.id)).json().data;
    await settle(changedCharge.reference, businessId);
    await processDurableOutbound((await load(changed.id))!.sendId!);
    expect((await load(changed.id))?.send).toMatchObject({ state: 'FAILED', reason: 'REMINDER_BALANCE_CHANGED', attempts: 0 });
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { reminderConsent: false } });
    await processDurableOutbound((await load(stopped.id))!.sendId!);
    expect((await load(stopped.id))?.send).toMatchObject({ state: 'FAILED', reason: 'REMINDER_CONSENT_STALE' });
    await prisma.customer.update({ where: { id: fixture.customer.id }, data: { reminderConsent: true } });
    await fixture.api('PUT', '/commerce/reminders/policy', { ...policy, enabled: false });
    await processDurableOutbound((await load(omitted.id))!.sendId!);
    expect((await load(omitted.id))?.send).toMatchObject({ state: 'FAILED', reason: 'REMINDER_DISABLED' });
    await fixture.api('PUT', '/commerce/reminders/policy', policy);

    sendMode = 'TIMEOUT';
    await processDurableOutbound((await load(ambiguous.id))!.sendId!);
    sendMode = 'OK';
    expect((await load(ambiguous.id))?.send).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'PROVIDER_OUTCOME_UNKNOWN', attempts: 1 });
    sendMode = 'RATE_LIMIT';
    const boundedId = (await load(bounded.id))!.sendId!;
    try {
      for (let i = 0; i < 5; i++) {
        await processDurableOutbound(boundedId);
        await prisma.whatsAppSend.updateMany({ where: { id: boundedId, state: 'RETRY_PENDING' }, data: { nextAttemptAt: new Date(0) } });
      }
    } finally { sendMode = 'OK'; }
    expect((await load(bounded.id))?.send).toMatchObject({ state: 'FAILED', reason: 'RATE_LIMITED', attempts: 5 });
    await interrupt('after-outbound-intent');
    await recoverDurableOutbound();
    const job = await outboundMessagesQueue.getJob('send-' + intent.sendId);
    expect(job).toBeDefined();
    await job!.remove();
    await prisma.whatsAppSend.update({ where: { id: intent.sendId! }, data: { nextAttemptAt: new Date(0) } });
    await recoverDurableOutbound();
    const running = outboundWorker.run();
    try {
      await expect.poll(async () => (await load(unpaid.id))?.send?.state, { timeout: 20_000 }).toBe('PROVIDER_ACCEPTED');
      const send = (await load(unpaid.id))!.send!;
      await signedDelivery(fixture.business.waPhoneNumberId!, fixture.customer.waNumber, send.id, send.providerMessageId!);
      await recoverDurableOutbound();
      expect((await load(unpaid.id))?.send).toMatchObject({ state: 'DELIVERED', providerMessageId: send.providerMessageId });
      expect(providerMessages.filter((message) => message.biz_opaque_callback_data === send.id)).toHaveLength(1);
    } finally { await outboundWorker.close(); await running; }
  }, 130_000);

  it('records consent from signed receipts and cancels a scheduled obligation with missing or revoked consent', async () => {
    const fixture = await createShop();
    const phone = fixture.business.waPhoneNumberId!;
    const { businessId } = fixture.scope;
    const { openTextReceiptQueue, dispatchTextReceipts } = await import('../src/workers/text-receipt.worker.js');
    const { recoverCommerceReminders } = await import('../src/modules/commerce/commerce.reminders.js');
    const producer = openTextReceiptQueue();
    const now = new Date();
    await prisma.$executeRaw`UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(+now - 60_000)}
      WHERE "phoneNumberId" = ${phone} AND "businessId" = ${businessId}`;
    async function consent(body: string, offset = 0) {
      const id = 'wamid.' + randomUUID();
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: phone }, messages: [{ id, from: fixture.customer.waNumber,
          type: 'text', text: { body }, timestamp: String(Math.floor((+now + offset) / 1000)) }],
      } }] }] });
      const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
        'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex'),
      } });
      expect(response.statusCode).toBe(200);
      await dispatchTextReceipts(producer.enqueue, new Date(), businessId);
      return prisma.whatsAppTextReceipt.findUniqueOrThrow({ where: { phoneNumberId_waMessageId: { phoneNumberId: phone, waMessageId: id } } });
    }
    try {
      const policy = await fixture.api('PUT', '/commerce/reminders/policy', { enabled: true, intervalDays: 3, maxReminders: 1,
        templateName: null, templateLanguage: null });
      expect(policy.statusCode).toBe(200);
      const createLateInvoice = () => prisma.commerceInvoice.create({ data: { ...fixture.scope, reference: randomUUID(),
        dueAt: new Date(+now - 2_000), total: 50, releaseThreshold: 50, receiptLines: [] } });
      const absent = await createLateInvoice();
      await recoverCommerceReminders();
      expect(await prisma.commerceReminder.findFirst({ where: { invoiceId: absent.id } })).toMatchObject({ status: 'CANCELLED', reason: 'NO_CURRENT_CONSENT', sendId: null });
      await producer.ready();
      const allowed = await consent('START PAYMENT REMINDERS');
      expect(await prisma.customer.findUnique({ where: { id: fixture.customer.id } })).toMatchObject({ reminderConsent: true, reminderConsentId: allowed.messageId });
      const stopped = await consent('STOP PAYMENT REMINDERS', 1000);
      await consent('START PAYMENT REMINDERS');
      expect(await prisma.customer.findUnique({ where: { id: fixture.customer.id } })).toMatchObject({ reminderConsent: false, reminderConsentId: stopped.messageId });
      const revoked = await createLateInvoice();
      await recoverCommerceReminders();
      expect(await prisma.commerceReminder.findFirst({ where: { invoiceId: revoked.id } })).toMatchObject({ status: 'CANCELLED', reason: 'NO_CURRENT_CONSENT', sendId: null });
    } finally { await producer.close(); }
  }, 60_000);

  it('serializes mixed item returns, preserves financial custody boundaries and rolls back failed stock updates', async () => {
    const fixture = await createShop();
    const foreign = await createShop();
    const { order, invoice, item, custom } = await seedOrder(fixture, 'FULFILLED', true);
    const { businessId } = fixture.scope;
    const checkout = await fixture.checkout(invoice.id);
    expect(checkout.statusCode, checkout.body).toBe(200);
    await settle(checkout.json().data.reference, businessId);
    const response = await fixture.api('POST', `/commerce/orders/${order.id}/return-case`);
    expect(response.statusCode, response.body).toBe(201);
    const support = response.json().data;
    const path = `/commerce/cases/${support.id}`;
    const trackedLine = order.items.find((line) => line.productId === item.id)!;
    const customLine = order.items.find((line) => line.productId === custom!.id)!;
    const manager = await prisma.staff.create({ data: { businessId, role: 'MANAGER', name: 'Fixture return manager', phone: '233207740949' } });
    const record = { requestKey: randomUUID(), revision: 0, evidence: 'One opened tracked unit and one custom item physically inspected',
      obligation: 'REFUND_REVIEW', lines: [{ orderItemId: trackedLine.id, quantity: 1, condition: 'RESTOCKABLE' },
        { orderItemId: customLine.id, quantity: 1, condition: 'DAMAGED' }] };
    const staff = { id: manager.id, role: 'MANAGER' as const };
    expect((await foreign.api('POST', path + '/returns', record)).statusCode).toBe(404);
    expect((await fixture.api('POST', path + '/returns', { ...record, lines: [{ ...record.lines[0]!, quantity: 3 }] }, staff)).statusCode).toBe(409);
    const received = await Promise.all([fixture.api('POST', path + '/returns', record, staff), fixture.api('POST', path + '/returns', record, staff)]);
    for (const result of received) expect(result.statusCode, result.body).toBe(201);
    const entry = received[0]!.json().data;
    expect(received[1]!.json().data.id).toBe(entry.id);
    expect(await prisma.stockMovement.count({ where: { orderId: order.id } })).toBe(0);
    expect((await fixture.api('POST', path + '/receive-return', { revision: 1 })).statusCode).toBe(409);
    const approve = () => fixture.api('POST', `${path}/returns/${entry.id}/decision`, { approve: true });
    await prisma.staff.update({ where: { id: manager.id }, data: { active: false } });
    expect((await approve()).statusCode).toBe(403);
    await prisma.staff.update({ where: { id: manager.id }, data: { active: true } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fixture_reject_return_stock() RETURNS trigger AS $$ BEGIN
      IF NEW.note = 'Verified item return' THEN RAISE EXCEPTION 'Synthetic return write failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER fixture_reject_return_stock BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION fixture_reject_return_stock()');
    try {
      expect((await approve()).statusCode).toBe(500);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).stockQuantity.toString()).toBe('2');
      expect(await prisma.commerceReturn.findUnique({ where: { id: entry.id } })).toMatchObject({ approvedAt: null });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fixture_reject_return_stock ON stock_movements');
      await prisma.$executeRawUnsafe('DROP FUNCTION fixture_reject_return_stock()');
    }
    for (const result of await Promise.all([approve(), approve()])) expect(result.statusCode, result.body).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).stockQuantity.toString()).toBe('3');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: custom!.id } })).stockQuantity.toString()).toBe('0');
    expect(await prisma.stockMovement.count({ where: { orderId: order.id, type: 'RETURN' } })).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await fixture.view(invoice.id)).toMatchObject({ state: 'VERIFIED_PAID', paid: '70' });
    expect(await prisma.commerceReturn.findUnique({ where: { id: entry.id } })).toMatchObject({ obligation: 'REFUND_REVIEW', resolvedAt: null, noticeId: expect.any(String) });
    const excessive = await fixture.api('POST', path + '/returns', { ...record, requestKey: randomUUID(), revision: 2,
      lines: [{ ...record.lines[0]!, quantity: 2 }] }, staff);
    expect(excessive.statusCode, excessive.body).toBe(409);
    expect((await fixture.api('PATCH', path, { state: 'RESOLVED', revision: 2, staffId: null })).statusCode).toBe(409);
    const refund = await fixture.api('POST', `/commerce/invoices/${invoice.id}/adjustments`, { amountMinor: 800, requestKey: randomUUID(),
      reference: 'return-ledger-fixture', reason: 'Recorded return credit accepted by the owner' });
    expect(refund.statusCode, refund.body).toBe(200);
    const resolved = await fixture.api('POST', `${path}/returns/${entry.id}/resolution`, { paymentId: refund.json().data.payment.id });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().data).toMatchObject({ resolvedAt: expect.any(String), resolutionPaymentId: refund.json().data.payment.id });
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id, direction: 'IN' } })).toBe(1);

    const exchange = await fixture.api('POST', path + '/returns', { ...record, requestKey: randomUUID(), revision: 3,
      obligation: 'EXCHANGE', lines: [{ orderItemId: trackedLine.id, quantity: 1, condition: 'DAMAGED' }] }, staff);
    expect(exchange.statusCode, exchange.body).toBe(201);
    const exchangePath = `${path}/returns/${exchange.json().data.id}`;
    expect((await fixture.api('POST', exchangePath + '/decision', { approve: true })).statusCode).toBe(200);
    expect((await fixture.api('POST', exchangePath + '/resolution', { evidenceMessageId: randomUUID() }, staff)).statusCode).toBe(404);
    const { openTextReceiptQueue, dispatchTextReceipts } = await import('../src/workers/text-receipt.worker.js');
    const producer = openTextReceiptQueue();
    try {
      await producer.ready();
      const remoteId = 'wamid.' + randomUUID();
      const phone = fixture.business.waPhoneNumberId!;
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: phone }, messages: [{ id: remoteId, from: fixture.customer.waNumber, type: 'text',
          text: { body: 'RESOLVED ' + support.id }, timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }] });
      const signed = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
        'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', metaSecret).update(payload).digest('hex'),
      } });
      expect(signed.statusCode).toBe(200);
      await dispatchTextReceipts(producer.enqueue, new Date(), businessId);
      const source = await prisma.whatsAppTextReceipt.findUniqueOrThrow({ where: { phoneNumberId_waMessageId: { phoneNumberId: phone, waMessageId: remoteId } } });
      const closed = await fixture.api('POST', exchangePath + '/resolution', { evidenceMessageId: source.messageId }, staff);
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json().data).toMatchObject({ resolvedAt: expect.any(String), obligation: 'EXCHANGE' });
      expect(await prisma.stockMovement.count({ where: { orderId: order.id, type: 'RETURN' } })).toBe(1);
    } finally { await producer.close(); }
  }, 100_000);

  it.each(['before-verification', 'after-verification', 'before-settlement-commit', 'after-settlement-commit',
    'before-preparation', 'after-preparation-write', 'after-workflow-commit'])('recovers one payment release after killed worker at %s', async (point) => {
    const fixture = await createShop();
    const hasDeposit = point === 'before-settlement-commit';
    const { order, invoice, source, item } = await seedOrder(fixture, 'CONFIRMED', false, hasDeposit ? 10 : 0);
    const { businessId } = fixture.scope;
    const { recoverWorkflows } = await import('../src/modules/workflows/workflow.worker.js');
    const { drainPaystackReceipts } = await import('../src/modules/payments/paystack-settlement.js');
    await prisma.workflowSettings.create({ data: { businessId, enabled: true, profile: 'ONLINE_RETAIL' } });
    const workflow = await prisma.workflow.create({ data: { ...fixture.scope, sourceId: source.id, orderId: order.id,
      correlationKey: 'crash:' + randomUUID(), definition: 'whatsapp-business', version: 3, policyRevision: 1,
      operator: 'PAYMENTS', state: 'WAITING_PROVIDER', reason: 'AWAITING_VERIFIED_PAYMENT',
      dueAt: null, deadlineAt: new Date(Date.now() + 3_600_000),
    } });
    if (hasDeposit) {
      const deposit = await fixture.checkout(invoice.id);
      expect(deposit.statusCode, deposit.body).toBe(200);
      await settle(deposit.json().data.reference, businessId);
      expect(await fixture.view(invoice.id)).toMatchObject({ state: 'PARTIALLY_PAID', due: '40' });
      expect(await prisma.commercePreparation.count({ where: { invoiceId: invoice.id } })).toBe(0);
    }
    const checkout = await fixture.checkout(invoice.id);
    expect(checkout.statusCode, checkout.body).toBe(200);
    const request = checkout.json().data;
    const id = transactionId++;
    await Promise.all([signedPaystack(request.reference, id), signedPaystack(request.reference, id)]);
    const isSettlement = point.includes('verification') || point.includes('settlement');
    const setDue = () => prisma.workflow.update({ where: { id: workflow.id }, data: { dueAt: new Date(0) } });
    if (!isSettlement) { await drainPaystackReceipts(businessId); await setDue(); }
    try {
      await interrupt(point, { B3_CRASH_BUSINESS: businessId, B3_CRASH_CHARGE: JSON.stringify(verification(request.reference, id)) },
        point === 'before-verification' ? () => Promise.all([signedPaystack(request.reference, id), drainPaystackReceipts(businessId)])
          : point === 'after-preparation-write' ? () => recoverWorkflows() : undefined);
      const alreadySettled = !isSettlement || point === 'after-settlement-commit';
      expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(Number(alreadySettled) + Number(hasDeposit));
      expect(await prisma.commercePreparation.count({ where: { invoiceId: invoice.id } })).toBe(point === 'after-workflow-commit' ? 1 : 0);
      if (!alreadySettled) await prisma.paystackReceipt.updateMany({ where: { reference: request.reference, state: 'PROCESSING' },
        data: { leaseUntil: new Date(0) } });
      await Promise.all([signedPaystack(request.reference, id), drainPaystackReceipts(businessId), drainPaystackReceipts(businessId)]);
      await setDue();
      await Promise.all([recoverWorkflows(), recoverWorkflows()]);
      expect(await prisma.paystackSettlement.count({ where: { requestId: request.id, transactionId: String(id) } })).toBe(1);
      expect(await prisma.payment.count({ where: { invoiceId: invoice.id, direction: 'IN' } })).toBe(1 + Number(hasDeposit));
      expect(await fixture.view(invoice.id)).toMatchObject({ state: 'VERIFIED_PAID', due: '0' });
      expect(await prisma.commercePreparation.count({ where: { invoiceId: invoice.id } })).toBe(1);
      expect(await prisma.workflowEvidence.count({ where: { workflowId: workflow.id, eventType: 'PAYMENT_SETTLED' } })).toBe(1);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).stockQuantity.toString()).toBe('2');
    } finally {
      await prisma.workflow.update({ where: { id: workflow.id }, data: { dueAt: null } });
    }
  }, 65_000);
});
