import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

setTimeout(() => process.exit(1), 360_000).unref();
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const endpoint = new URL(process.env[name]);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(endpoint.port && (name === 'DATABASE_URL' ? endpoint.pathname.startsWith('/flowdesk_g1_') : endpoint.port !== '6379'));
}

process.env.PAYSTACK_SECRET_KEY = 'sk_test_retail_signoff_fixture';
process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_retail_signoff_fixture';
process.env.RESEND_API_KEY = 'synthetic-signoff-mail';
process.env.RESEND_FROM_EMAIL = 'fixture@flowdesk.invalid';
const authorizations = new Map();
const settlements = new Map();
const codes = new Map();
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'api.resend.com' && url.pathname === '/emails') {
    const mail = JSON.parse(String(options.body));
    const code = /^(\d{6}) is your Flowdesk code$/.exec(mail.subject)?.[1];
    if (code && mail.to[0].endsWith('@flowdesk.invalid')) codes.set(mail.to[0], code);
    return Response.json({ id: 'mail-fixture' });
  }
  if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/messages')) {
    return Response.json({ messages: [{ id: 'wamid.' + randomUUID() }] });
  }
  if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize') {
    const request = JSON.parse(String(options.body));
    assert.ok(!authorizations.has(request.reference), 'A checkout reference reached the provider twice');
    authorizations.set(request.reference, { ...request, metadata: JSON.parse(request.metadata) });
    return Response.json({ status: true, data: { reference: request.reference,
      authorization_url: 'https://checkout.invalid/' + request.reference, access_code: 'retail-fixture' } });
  }
  if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/')) {
    return Response.json({ status: true, data: settlements.get(url.pathname.split('/').at(-1)) });
  }
  assert.equal(url.hostname, '127.0.0.1', 'Only synthetic transports are allowed');
  return localFetch(input, options);
};

const load = (file) => import(pathToFileURL(resolve(file)).href);
const { chromium } = await load(process.env.B2_PLAYWRIGHT);
const { prisma } = await load('apps/api/dist/config/database.js');
const { connectRedis, disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const { openTextReceiptQueue, dispatchTextReceipts } = await load('apps/api/dist/workers/text-receipt.worker.js');
const { intentClassifierWorker } = await load('apps/api/dist/workers/intent-classifier.worker.js');
const { outboundWorker, startDurableOutboundRecovery } = await load('apps/api/dist/workers/outbound.worker.js');
const { startFulfillmentRecovery } = await load('apps/api/dist/workers/fulfillment-recovery.js');
const { startWorkflowRecovery } = await load('apps/api/dist/modules/workflows/workflow.worker.js');
const { drainPaystackReceipts } = await load('apps/api/dist/modules/payments/paystack-settlement.js');
await connectRedis();
const app = await createApp();
const gateway = releaseGateway(new URL(await app.listen({ host: '127.0.0.1', port: 0 })), resolve('apps/web/dist'));
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const base = 'http://127.0.0.1:' + gateway.address().port;
const browser = await chromium.launch({ executablePath: process.env.B2_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
const producer = openTextReceiptQueue();
await producer.ready();
const workers = [intentClassifierWorker, outboundWorker];
const running = workers.map((worker) => worker.run());
const stop = [startWorkflowRecovery(), startDurableOutboundRecovery(), startFulfillmentRecovery()];

async function until(description, lookup) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await lookup();
    if (result) return result;
    await delay(200);
  }
  throw new Error('Timed out awaiting ' + description);
}

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(24_000);
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const email = `retail-${randomUUID()}@flowdesk.invalid`;
  await page.goto(base + '/register');
  await page.getByLabel('Business name').fill('Retail sign-off fixture');
  await page.getByLabel('Your name').fill('Fixture owner');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Retail-browser-fixture-2026!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Code').fill(await until('synthetic verification mail', () => codes.get(email)));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByRole('radio', { name: /Retail and online sales/ }).check();
  await page.getByRole('button', { name: 'Save business profile' }).click();
  await page.getByText('Business profile saved.').waitFor();
  const business = await prisma.business.findUniqueOrThrow({ where: { email } });
  assert.ok(business.emailVerifiedAt);
  const phone = 'retail-fixture-' + randomUUID();
  const waNumber = '233208730001';
  const scope = { businessId: business.id };
  await prisma.business.update({ where: { id: business.id }, data: { waPhoneNumberId: phone, waAccessToken: 'synthetic-fixture-only',
    paystackSubaccountCode: 'ACCT_' + randomUUID(), receiptsEnabled: true } });
  await prisma.$executeRaw`UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(Date.now() - 60_000)}
    WHERE "businessId" = ${business.id} AND "phoneNumberId" = ${phone}`;

  await page.goto(base + '/dashboard?view=work');
  await page.getByText('Workflow settings', { exact: true }).click();
  await page.getByLabel('Track new WhatsApp work').check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await until('workflow configuration', async () => (await prisma.workflowSettings.findUnique({ where: scope }))?.enabled);
  await page.goto(base + '/orders?workspace=quotes');
  await page.getByText('Commerce settings', { exact: true }).click();
  await page.getByLabel('Enable commerce in WhatsApp').check();
  await page.getByRole('button', { name: 'Save commerce settings' }).click();
  await until('commerce configuration', async () => (await prisma.commercePolicy.findUnique({ where: scope }))?.enabled);

  await page.goto(base + '/products');
  async function addProduct(name, sku, price, baseId) {
    await page.getByRole('button', { name: 'Add product', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Sold by').fill('piece');
    await page.getByLabel('SKU for WhatsApp quotes').fill(sku);
    await page.getByLabel('Price, in cedis').fill(String(price));
    await page.getByLabel('In stock now').fill('5');
    if (baseId) {
      await page.getByLabel('Variant of').selectOption(baseId);
      await page.getByLabel('Variant label').fill('Blue');
    }
    await page.getByRole('button', { name: 'Add product', exact: true }).click();
    return until('catalogue product ' + sku, () => prisma.product.findUnique({ where: { businessId_sku: { ...scope, sku } } }));
  }
  const parent = await addProduct('Fixture case', 'CASE-BASE', 20);
  const variant = await addProduct('Fixture blue case', 'CASE-BLUE', 25, parent.id);
  assert.equal(variant.variantOfId, parent.id);

  async function meta(value) {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
      value: { metadata: { phone_number_id: phone }, ...value } }] }] });
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: { 'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', process.env.META_WEBHOOK_SECRET).update(payload).digest('hex') } });
    assert.equal(response.statusCode, 200, response.body);
  }
  async function inbound(body) {
    const id = 'wamid.' + randomUUID();
    const envelope = { messages: [{ id, from: waNumber, type: 'text', text: { body }, timestamp: String(Math.floor(Date.now() / 1000)) }] };
    await meta(envelope);
    await meta(envelope);
    await dispatchTextReceipts(producer.enqueue, new Date(), business.id);
    return until('durable inbound message', async () => (await prisma.whatsAppTextReceipt.findUnique({
      where: { phoneNumberId_waMessageId: { phoneNumberId: phone, waMessageId: id } },
    }))?.messageId);
  }
  async function deliver(eventKey) {
    const send = await until('provider accepted ' + eventKey, () => prisma.whatsAppSend.findFirst({ where: { ...scope, eventKey, state: 'PROVIDER_ACCEPTED' } }));
    await meta({ statuses: [{ id: send.providerMessageId, status: 'delivered', recipient_id: waNumber,
      timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: send.id }] });
    await until('signed provider delivery', () => prisma.whatsAppSend.findFirst({ where: { id: send.id, state: 'DELIVERED' } }));
  }

  const source = await inbound('QUOTE CASE-BLUE*2 PICKUP');
  const quote = await until('grounded quote', () => prisma.commerceQuote.findFirst({ where: { ...scope, sourceId: source, state: 'OFFERED' } }));
  assert.equal(quote.total.toFixed(2), '50.00');
  await deliver('commerce-quote-' + quote.id);
  await page.goto(base + '/messages?c=' + quote.customerId);
  await page.getByText('QUOTE CASE-BLUE*2 PICKUP', { exact: true }).waitFor();
  await inbound('ACCEPT ' + quote.id);
  const accepted = await until('exact accepted quote', () => prisma.commerceQuote.findFirst({ where: { ...scope, id: quote.id, state: 'ACCEPTED', orderId: { not: null } } }));
  assert.equal(await prisma.order.count({ where: { ...scope, customerId: quote.customerId } }), 1);
  const invoice = await prisma.commerceInvoice.findUniqueOrThrow({ where: { orderId: accepted.orderId } });
  await deliver('commerce-invoice-' + invoice.id);
  await page.goto(base + '/orders?order=' + invoice.orderId);
  const invoicePanel = page.getByRole('region', { name: 'Commerce invoice' });
  await invoicePanel.getByRole('button', { name: 'Send payment link', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await invoicePanel.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  await page.reload();
  await invoicePanel.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  assert.equal(authorizations.size, 1);
  const auth = [...authorizations.values()][0];
  assert.equal(auth.amount, 5000);
  assert.equal(auth.metadata.flowdeskInvoiceId, invoice.id);
  const evidence = { id: 870001, reference: auth.reference, amount: auth.amount, currency: 'GHS', status: 'success', domain: 'test',
    paid_at: new Date().toISOString(), channel: 'card', subaccount: { subaccount_code: auth.subaccount }, metadata: auth.metadata };
  settlements.set(auth.reference, evidence);
  const payload = JSON.stringify({ event: 'charge.success', data: evidence });
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload, headers: { 'content-type': 'application/json',
      'x-paystack-signature': createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(payload).digest('hex') } });
    assert.equal(response.statusCode, 200, response.body);
  }
  await drainPaystackReceipts(business.id);
  const settlement = await until('verified charge', () => prisma.paystackSettlement.findFirst({ where: { request: { ...scope, invoiceId: invoice.id } } }));
  assert.equal(await prisma.payment.count({ where: { ...scope, invoiceId: invoice.id, confidence: 'GATEWAY_CONFIRMED' } }), 1);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: settlement.paymentId } })).amount.toFixed(2), '50.00');
  await invoicePanel.getByText(/Verified payment/).waitFor();
  await page.getByRole('button', { name: 'Start packing', exact: true }).click();
  await invoicePanel.getByRole('button', { name: 'Mark preparation complete' }).click();
  await invoicePanel.getByText('Packing · Ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
  await until('verified pickup', () => prisma.commercePreparation.findFirst({ where: { ...scope, invoiceId: invoice.id, state: 'COLLECTED' } }));
  const order = await prisma.order.findUniqueOrThrow({ where: { id: invoice.orderId } });
  assert.equal(order.status, 'FULFILLED');
  assert.equal(order.customerId, quote.customerId);
  assert.equal(order.businessId, business.id);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: variant.id } })).stockQuantity.toString(), '3');
  await deliver('order-status-' + order.id + '-FULFILLED');
  const workflow = await until('completed workflow evidence', () => prisma.workflow.findFirst({ where: { ...scope, orderId: order.id, state: 'COMPLETED' } }));
  await page.goto(base + '/dashboard?view=work&work=' + workflow.id);
  await page.getByRole('region', { name: 'Work details' }).getByRole('link', { name: order.referenceNumber }).waitFor();
  console.log('PASS retail signup, signed quote and purchase, one checkout after refresh, verified settlement, pickup, delivery evidence and owner workflow.');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => { gateway.close(done); gateway.closeAllConnections(); });
  app.server.closeAllConnections();
  await app.close();
  await Promise.all(stop.map((end) => end()));
  await producer.close();
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.allSettled(running);
  await prisma.$disconnect();
  await disconnectRedis();
}
process.exit(0);
