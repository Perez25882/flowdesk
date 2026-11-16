import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

setTimeout(() => process.exit(1), 230_000).unref();
const root = process.cwd();
for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
  const fixture = new URL(process.env[variable]);
  if (fixture.hostname !== '127.0.0.1' || !fixture.port ||
      (variable === 'DATABASE_URL' && !fixture.pathname.startsWith('/flowdesk_g1_')) ||
      (variable === 'REDIS_URL' && fixture.port === '6379')) throw new Error('Use disposable IPv4 fixtures');
}

const load = (file) => import(pathToFileURL(resolve(root, file)).href);
const paySecret = 'sk_test_chromium_commerce_completion';
process.env.PAYSTACK_SECRET_KEY = paySecret;
process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_chromium_commerce_completion';
const initializations = [];
const verifiedCharges = new Map();
const priorFetch = globalThis.fetch;
let paused;
let ambiguousInvoice;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize') {
    const body = JSON.parse(String(options.body));
    body.metadata = JSON.parse(body.metadata);
    initializations.push(body);
    if (body.metadata.flowdeskInvoiceId === ambiguousInvoice) throw new Error('Synthetic ambiguous initialization timeout');
    if (paused) await paused;
    return Response.json({ status: true, data: { reference: body.reference,
      authorization_url: 'https://checkout.invalid/' + body.reference, access_code: 'synthetic' } });
  }
  if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/')) {
    return Response.json({ status: true, data: verifiedCharges.get(url.pathname.split('/').at(-1)) });
  }
  return priorFetch(input, options);
};
const { chromium } = await import(pathToFileURL(process.env.B2_PLAYWRIGHT).href);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { releasePreparation } = await load('apps/api/dist/modules/commerce/commerce.fulfillment.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const require = createRequire(pathToFileURL(resolve(root, 'apps/api/dist/app.js')));
const email = 'commerce-' + randomUUID() + '@flowdesk.invalid';
const password = 'Fixture-local-2026!';
const phone = 'fixture-' + randomUUID();
const business = await prisma.business.create({ data: {
  name: 'Synthetic commerce owner', ownerName: 'Fixture owner', email, emailVerifiedAt: new Date(),
  passwordHash: await require('bcrypt').hash(password, 4), waPhoneNumberId: phone, waAccessToken: 'synthetic-chromium-token',
  paystackSubaccountCode: 'ACCT_' + randomUUID(),
} });
const customer = await prisma.customer.create({ data: {
  businessId: business.id, waNumber: '233208000001', name: 'Synthetic retail customer', lastInboundAt: new Date(),
} });
const scope = { businessId: business.id, customerId: customer.id };
await prisma.workflowSettings.create({ data: { businessId: business.id, profile: 'ONLINE_RETAIL', enabled: true } });
await prisma.commercePolicy.create({ data: { businessId: business.id, enabled: true, allowDelivery: true } });
const product = await prisma.product.create({ data: { businessId: business.id, name: 'Fixture item', sku: 'FIXTURE', unit: 'piece', price: 12,
  stockQuantity: 2, commerceMode: 'TRACKED' } });
const source = await prisma.message.create({ data: { ...scope, waMessageId: randomUUID(), direction: 'INBOUND', type: 'TEXT',
  processed: true, body: 'Synthetic accepted order evidence' } });
const order = await prisma.order.create({ data: {
  ...scope, referenceNumber: 'FD-QBROWSER', rawMessage: 'Synthetic accepted order', status: 'CONFIRMED', totalAmount: 24, amountPaid: 24,
  stockDeducted: true, inboundSourceMessageId: source.id,
  items: { create: { productId: product.id, description: product.name, quantity: 2, unitPrice: 12, subtotal: 24, matched: true } },
} });
await prisma.commerceQuote.create({ data: {
  ...scope, orderId: order.id, requestKey: randomUUID(), requestHash: randomUUID(), state: 'ACCEPTED', deliveryMode: 'PICKUP',
  total: 24, policyRevision: 1, expiresAt: new Date(Date.now() + 3_600_000), acceptedAt: new Date(),
  lines: { create: { productId: product.id, sku: product.sku, itemName: product.name, quantity: 2, productMode: 'TRACKED', listPrice: 12, unitPrice: 12 } },
} });
const invoice = await prisma.commerceInvoice.create({ data: {
  ...scope, orderId: order.id, reference: 'INV-QBROWSER', total: 24, releaseThreshold: 24, dueAt: new Date(Date.now() + 86_400_000),
  receiptLines: [{ name: 'Fixture item', quantity: 2, unitPrice: '12.00', subtotal: '24.00' }],
} });
const reference = 'fdpay-' + randomUUID();
const payment = await prisma.payment.create({ data: {
  ...scope, orderId: order.id, amount: 24, confidence: 'GATEWAY_CONFIRMED', method: 'CARD', direction: 'IN', reference,
} });
const request = await prisma.paymentRequest.create({ data: {
  ...scope, orderId: order.id, amount: 24, reference, authorizationUrl: 'https://checkout.invalid', status: 'PAID',
  paymentId: payment.id, expiresAt: new Date(Date.now() + 3_600_000), paidAt: new Date(),
} });
const receipt = await prisma.paystackReceipt.create({ data: {
  eventKey: randomUUID(), reference, requestId: request.id, businessId: business.id, state: 'SETTLED',
} });
await prisma.paystackSettlement.create({ data: { transactionId: randomUUID(), requestId: request.id,
  paymentId: payment.id, receiptId: receipt.id, notificationState: 'SUPPRESSED' } });
if (!await prisma.$transaction((tx) => releasePreparation(tx, business.id, order.id))) throw new Error('Verified prep fixture did not release');
await prisma.workflow.create({ data: {
  ...scope, sourceId: source.id, correlationKey: 'browser:' + randomUUID(), definition: 'whatsapp-business', version: 3,
  policyRevision: 1, operator: 'FULFILLMENT', state: 'WAITING_STAFF', reason: 'READY_FOR_FULFILLMENT', orderId: order.id,
  deadlineAt: new Date(Date.now() + 3_600_000), evidence: { create: {
    eventKey: 'browser:verified-payment', eventType: 'PAYMENT_SETTLED', operator: 'FULFILLMENT', state: 'WAITING_STAFF',
    reason: 'READY_FOR_FULFILLMENT', facts: { orderId: order.id, invoiceId: invoice.id, paymentId: payment.id },
  } },
} });

const initial = await prisma.message.create({ data: { ...scope, waMessageId: randomUUID(),
  direction: 'INBOUND', type: 'TEXT', processed: true, body: 'Wrong item FD-QBROWSER' } });
const item = await prisma.commerceCase.create({ data: {
  ...scope, sourceId: initial.id, orderId: order.id, kind: 'COMPLAINT', history: { create: { revision: 0, state: 'OPEN' } },
} });
const confirmation = await prisma.message.create({ data: { ...scope, waMessageId: randomUUID(),
  direction: 'INBOUND', type: 'TEXT', processed: true, body: 'RESOLVED ' + item.id } });
const binding = await prisma.whatsAppPhoneOwnership.findFirstOrThrow({ where: { businessId: business.id, phoneNumberId: phone, endedAt: null } });
await prisma.whatsAppTextReceipt.create({ data: { businessId: business.id, phoneNumberId: phone, messageId: confirmation.id,
  ownershipId: binding.id, waMessageId: confirmation.waMessageId, sentAt: new Date(), status: 'COMPLETED', kind: 'TEXT' } });

const app = await createApp();
const api = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
const gateway = releaseGateway(api, resolve(root, 'apps/web/dist'));
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const base = 'http://127.0.0.1:' + gateway.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.B2_CHROMIUM, args: ['--disable-background-networking'] });
async function waitFor(read, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolveLater) => setTimeout(resolveLater, 200));
  }
  throw new Error('Browser fixture timed out awaiting ' + description);
}
async function settle(charge, id) {
  const evidence = { id, reference: charge.reference, status: 'success', amount: charge.amount, domain: 'test', currency: 'GHS',
    paid_at: new Date().toISOString(), channel: 'card', subaccount: { subaccount_code: charge.subaccount }, metadata: charge.metadata };
  verifiedCharges.set(charge.reference, evidence);
  const payload = JSON.stringify({ event: 'charge.success', data: evidence });
  const reply = await app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload, headers: {
    'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', paySecret).update(payload).digest('hex'),
  } });
  if (reply.statusCode !== 200) throw new Error('Browser fixture payment admission failed');
  await (await load('apps/api/dist/modules/payments/paystack-settlement.js')).drainPaystackReceipts(business.id);
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let authorization;
  page.on('request', (request) => {
    const candidate = request.headers().authorization;
    if (candidate && request.url().includes('/api/v1/commerce/')) authorization = candidate;
  });
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(base + '/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();

  await page.goto(base + '/products');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser configured product');
  await page.getByLabel('Sold by').fill('piece');
  await page.getByLabel('SKU for WhatsApp quotes').fill('UI-SKU');
  await page.getByLabel('Price, in cedis').fill('15.50');
  await page.getByLabel('In stock now').fill('2');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByText('Browser configured product', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser fixture blue variant');
  await page.getByLabel('Sold by').fill('piece');
  await page.getByLabel('SKU for WhatsApp quotes').fill('UI-BLUE');
  await page.getByLabel('Price, in cedis').fill('16.50');
  await page.getByLabel('Variant of').selectOption(product.id);
  await page.getByLabel('Variant label').fill('Blue');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByText('Browser fixture blue variant', { exact: true }).waitFor();

  await page.goto(base + '/orders');
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await page.getByRole('radio', { name: 'Existing', exact: true }).click();
  await page.getByLabel('Choose a customer').selectOption(customer.id);
  await page.getByRole('button', { name: 'From catalogue', exact: true }).click();
  await page.getByLabel('Item 1 product').selectOption(product.id);
  await page.getByRole('button', { name: 'Create order', exact: true }).click();
  const manualOrder = await waitFor(() => prisma.order.findFirst({ where: { ...scope, isManual: true, id: { not: order.id } }, include: { items: true } }), 'manual order');
  if (manualOrder.items[0]?.productId !== product.id || !manualOrder.totalAmount.eq(12)) throw new Error('Browser manual order did not persist scoped items');
  await page.getByText(order.referenceNumber, { exact: true }).first().click();
  const invoicePanel = page.getByRole('region', { name: 'Commerce invoice' });
  await invoicePanel.getByText('Invoice ' + invoice.reference, { exact: true }).waitFor();
  await invoicePanel.getByRole('region', { name: 'Payment reminders' }).getByText('No reminders recorded.').waitFor();
  await invoicePanel.getByText(/Verified payment/).waitFor();
  await page.getByRole('button', { name: 'Start packing', exact: true }).click();
  await invoicePanel.getByRole('button', { name: 'Mark preparation complete', exact: true }).click();
  await invoicePanel.getByText('Packing · Ready', { exact: true }).waitFor();

  await page.goto(base + '/dashboard?view=work');
  await page.getByText(/Fulfillment & Operations · Needs staff action/).waitFor();
  await page.goto(base + '/messages?view=cases');
  await page.getByRole('button', { name: 'View case', exact: true }).click();
  await page.getByText('Customer confirmed the resolution.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resolve case', exact: true }).click();
  await page.getByRole('region', { name: 'Customer case' }).getByText('Complaint · Resolved', { exact: true }).waitFor();
  const [savedProduct, prepared, resolved] = await Promise.all([
    prisma.product.findUnique({ where: { businessId_sku: { businessId: business.id, sku: 'UI-SKU' } } }),
    prisma.commercePreparation.findUnique({ where: { invoiceId: invoice.id } }),
    prisma.commerceCase.findUnique({ where: { id: item.id } }),
  ]);
  if (!savedProduct?.price.eq('15.50') || prepared?.state !== 'READY' || resolved?.state !== 'RESOLVED') {
    throw new Error('Browser action did not persist expected commerce state');
  }
  const savedVariant = await prisma.product.findUnique({ where: { businessId_sku: { businessId: business.id, sku: 'UI-BLUE' } } });
  if (savedVariant?.variantOfId !== product.id || savedVariant?.variantLabel !== 'Blue') throw new Error('Variant did not persist');
  await page.goto(base + '/orders');
  await page.getByText(order.referenceNumber, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
  await page.getByRole('button', { name: 'Open item return case', exact: true }).click();
  await page.getByText('Record item return', { exact: true }).click();
  await page.getByLabel('Order item').selectOption({ label: 'Fixture item (2 purchased)' });
  await page.getByLabel('Condition').selectOption('RESTOCKABLE');
  await page.getByRole('button', { name: 'Add returned item' }).click();
  await page.getByLabel('Custody evidence').fill('Staff verified one sealed returned unit');
  await page.getByLabel('Outstanding obligation').selectOption('REFUND_REVIEW');
  await page.getByRole('button', { name: 'Record custody for approval' }).click();
  await page.getByRole('button', { name: 'Approve returned items' }).click();
  await page.getByText(/Stock restored/).waitFor();
  await page.getByText('Refund review · Outstanding').waitFor();
  const [stock, partialReturn, collection] = await Promise.all([
    prisma.product.findUnique({ where: { id: product.id } }),
    prisma.commerceReturn.findFirst({ where: { orderId: order.id }, include: { lines: true } }),
    prisma.commercePreparation.findUnique({ where: { invoiceId: invoice.id } }),
  ]);
  if (!stock?.stockQuantity.eq(3) || partialReturn?.lines?.length !== 1 || !partialReturn.lines[0].movementId || collection?.state !== 'COLLECTED') {
    throw new Error('Return or pickup UI did not persist the expected order evidence');
  }

  await page.goto(base + '/payments?view=invoices');
  async function showInvoices() {
    if (new URL(page.url()).pathname !== '/payments') await page.goto(base + '/payments?view=invoices');
    await page.getByRole('button', { name: 'New standalone invoice' }).waitFor();
    await page.getByLabel('Standalone invoices only').check();
  }
  const standalonePanel = page.getByRole('region', { name: 'Standalone invoice' });
  async function createInvoice(description) {
    await page.getByRole('button', { name: 'New standalone invoice' }).click();
    await page.getByRole('form', { name: 'New invoice' }).getByRole('combobox').selectOption(customer.id);
    await page.getByLabel('Due date').fill(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
    await page.getByLabel('Description').fill(description);
    await page.getByLabel('Unit price (GHS)').fill('50');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByRole('button', { name: 'Issue invoice' }).click();
    await standalonePanel.getByRole('button', { name: 'Send payment link' }).waitFor();
    return prisma.commerceInvoice.findFirstOrThrow({ where: { ...scope, orderId: null, receiptLines: { array_contains: [{
      name: description, sku: null, quantity: 1, listPrice: '50.00', unitPrice: '50.00', subtotal: '50.00',
    }] } } });
  }
  await showInvoices();
  const standalone = await createInvoice('Browser standalone service');
  const originalView = await page.request.get(base + '/api/v1/commerce/invoices/' + standalone.id, { headers: { authorization } });
  const version = (await originalView.json()).data.checkoutVersion;
  let resume;
  paused = new Promise((resolveProvider) => { resume = resolveProvider; });
  try {
    await standalonePanel.getByLabel('Payment amount (GHS)').fill('10');
    await standalonePanel.getByRole('button', { name: 'Send payment link' }).evaluate((button) => { button.click(); button.click(); });
    const charge = await waitFor(() => initializations.find((entry) => entry.metadata.flowdeskInvoiceId === standalone.id), 'provider initialize');
    await page.reload();
    await showInvoices();
    await page.getByRole('button', { name: standalone.reference, exact: true }).click();
    await page.getByText('The payment link is being prepared. This status updates automatically.').waitFor();
    resume();
    paused = null;
    await page.getByRole('link', { name: 'Open existing payment link' }).waitFor();
    await standalonePanel.getByRole('button', { name: 'Send payment link' }).click();
    await page.getByText('Payment link is ready.').waitFor();
    await Promise.all([page.reload(), settle(charge, 950001)]);
  } finally { resume(); paused = null; }
  await showInvoices();
  await page.getByRole('button', { name: standalone.reference, exact: true }).click();
  await page.getByText(/Partially paid/).waitFor();
  const stale = await page.request.post(base + '/api/v1/commerce/invoices/' + standalone.id + '/checkout', {
    headers: { authorization }, data: { amountMinor: 1000, checkoutVersion: version },
  });
  if (stale.status() !== 409) throw new Error('Stale browser action was not rejected');
  await standalonePanel.getByRole('button', { name: 'Send payment link' }).click();
  await page.getByText('Payment link is ready.').waitFor();
  const standCharges = initializations.filter((entry) => entry.metadata.flowdeskInvoiceId === standalone.id);
  if (standCharges.length !== 2 || standCharges[0].amount !== 1000 || standCharges[1].amount !== 4000) throw new Error('Browser checkout identities or amounts disagree');
  await settle(standCharges[1], 950002);
  await page.getByText(/Verified payment · Due/).waitFor();
  if (await prisma.payment.count({ where: { invoiceId: standalone.id, confidence: 'GATEWAY_CONFIRMED' } }) !== 2) throw new Error('Browser payment ledger count disagrees');

  const orderInvoice = await prisma.commerceInvoice.create({ data: { ...scope, orderId: manualOrder.id,
    reference: 'INV-BROWSER-REOPEN', dueAt: new Date(Date.now() + 86_400_000), total: manualOrder.totalAmount,
    releaseThreshold: manualOrder.totalAmount, receiptLines: [{ name: product.name, quantity: 1, unitPrice: '12.00', subtotal: '12.00' }] } });
  await page.goto(base + '/orders');
  await page.getByText(manualOrder.referenceNumber, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Send payment link' }).click();
  await page.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  await page.reload();
  await page.getByText(manualOrder.referenceNumber, { exact: true }).first().click();
  await page.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  await page.getByRole('button', { name: 'Send payment link' }).click();
  await page.getByText('Payment link is ready.').waitFor();
  const orderCharges = initializations.filter((entry) => entry.metadata.flowdeskInvoiceId === orderInvoice.id);
  if (orderCharges.length !== 1 || orderCharges[0].metadata.flowdeskOrderId !== manualOrder.id) throw new Error('Order drawer created a new provider request after refresh');
  await page.goto(base + '/dashboard');
  await showInvoices();

  await page.getByText('Payment reminder settings', { exact: true }).click();
  await page.getByLabel('Enable reminders for opted-in customers').check();
  await page.getByRole('button', { name: 'Save reminder settings' }).click();
  await waitFor(async () => (await prisma.commerceReminderPolicy.findUnique({ where: { businessId: business.id } }))?.enabled, 'reminder settings');
  const reminderInvoice = await prisma.commerceInvoice.create({ data: { ...scope, reference: 'INV-BROWSER-REMINDER',
    dueAt: new Date(Date.now() - 3_600_000), total: 25, releaseThreshold: 25, receiptLines: [] } });
  await prisma.customer.update({ where: { id: customer.id }, data: { reminderConsent: true, reminderConsentId: confirmation.id,
    reminderConsentAt: new Date(), lastInboundAt: new Date() } });
  await (await load('apps/api/dist/modules/commerce/commerce.reminders.js')).recoverCommerceReminders();
  await page.reload();
  await showInvoices();
  await page.getByRole('button', { name: reminderInvoice.reference, exact: true }).click();
  await page.getByRole('heading', { name: 'Payment reminders', exact: true }).waitFor();
  await page.getByText('AUTHORIZED', { exact: true }).waitFor();
  const reminder = await prisma.commerceReminder.findFirst({ where: { invoiceId: reminderInvoice.id }, include: { send: true } });
  if (reminder?.send?.payload?.commerceReminder?.balance !== '25.00') throw new Error('Browser reminder did not point to the outstanding balance');

  const incomplete = await createInvoice('Browser provider timeout case');
  ambiguousInvoice = incomplete.id;
  await standalonePanel.getByRole('button', { name: 'Send payment link' }).click();
  await page.getByText(/This checkout needs payment review/).waitFor();
  await page.reload();
  await showInvoices();
  await page.getByRole('button', { name: incomplete.reference, exact: true }).click();
  await page.getByText(/This checkout needs payment review/).waitFor();
  const repeat = await page.request.post(base + '/api/v1/commerce/invoices/' + incomplete.id + '/checkout', { headers: { authorization }, data: {} });
  if (repeat.status() !== 409 || initializations.filter((entry) => entry.metadata.flowdeskInvoiceId === incomplete.id).length !== 1) {
    throw new Error('Browser repeated an ambiguous provider action');
  }
  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  await page.getByText(/Cancelled · Due/).waitFor();
  const secondEmail = 'commerce-second-' + randomUUID() + '@flowdesk.invalid';
  await prisma.business.create({ data: { name: 'Second browser business', ownerName: 'Different owner', email: secondEmail,
    emailVerifiedAt: new Date(), passwordHash: await require('bcrypt').hash(password, 4) } });
  await page.getByRole('button', { name: 'More sections' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('#email').fill(secondEmail);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await showInvoices();
  await page.getByText('No standalone invoices yet.').waitFor();
  const isolated = await page.request.get(base + '/api/v1/commerce/invoices/' + standalone.id, { headers: { authorization } });
  if (isolated.status() !== 404) throw new Error('Browser account switch exposed another business invoice');
  const accidentallyStored = await page.evaluate(() => Object.keys({ ...localStorage, ...sessionStorage }).some((key) => /checkout|invoice|token/i.test(key)));
  if (accidentallyStored) throw new Error('Browser persisted invoice or checkout credentials');
  console.log('PASS mobile Chromium variant, order, invoice, packing, pickup, return, verified support resolution, checkout refresh and tenant switch');
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}
process.exit(0);
