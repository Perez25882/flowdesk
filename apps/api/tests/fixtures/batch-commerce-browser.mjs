import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

setTimeout(() => process.exit(1), 150_000).unref();
const root = process.cwd();
for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
  const fixture = new URL(process.env[variable]);
  if (fixture.hostname !== '127.0.0.1' || !fixture.port ||
      (variable === 'DATABASE_URL' && !fixture.pathname.startsWith('/flowdesk_g1_')) ||
      (variable === 'REDIS_URL' && fixture.port === '6379')) throw new Error('Use disposable IPv4 fixtures');
}

const load = (file) => import(pathToFileURL(resolve(root, file)).href);
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
  passwordHash: await require('bcrypt').hash(password, 4), waPhoneNumberId: phone,
} });
const customer = await prisma.customer.create({ data: {
  businessId: business.id, waNumber: '233208000001', name: 'Synthetic retail customer', lastInboundAt: new Date(),
} });
const scope = { businessId: business.id, customerId: customer.id };
await prisma.workflowSettings.create({ data: { businessId: business.id, profile: 'ONLINE_RETAIL', enabled: true } });
await prisma.commercePolicy.create({ data: { businessId: business.id, enabled: true, allowDelivery: true } });
const product = await prisma.product.create({ data: { businessId: business.id, name: 'Fixture item', sku: 'FIXTURE', unit: 'piece', price: 24 } });
const order = await prisma.order.create({ data: {
  ...scope, referenceNumber: 'FD-QBROWSER', rawMessage: 'Synthetic accepted order', status: 'CONFIRMED', totalAmount: 24, amountPaid: 24,
  stockDeducted: true, deliveryAddress: 'Synthetic address',
} });
await prisma.commerceQuote.create({ data: {
  ...scope, orderId: order.id, requestKey: randomUUID(), requestHash: randomUUID(), state: 'ACCEPTED', deliveryMode: 'DELIVERY',
  address: 'Synthetic address', total: 24, policyRevision: 1, expiresAt: new Date(Date.now() + 3_600_000), acceptedAt: new Date(),
  lines: { create: { productId: product.id, sku: product.sku, itemName: product.name, quantity: 1, productMode: 'TRACKED', listPrice: 24, unitPrice: 24 } },
} });
const invoice = await prisma.commerceInvoice.create({ data: {
  ...scope, orderId: order.id, reference: 'INV-QBROWSER', total: 24, releaseThreshold: 24, dueAt: new Date(Date.now() + 86_400_000),
  receiptLines: [{ name: 'Fixture item', quantity: 1, unitPrice: '24.00', subtotal: '24.00' }],
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
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(base + '/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Commerce', exact: true }).waitFor();

  await page.goto(base + '/products');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser configured product');
  await page.getByLabel('Sold by').fill('piece');
  await page.getByLabel('SKU for WhatsApp quotes').fill('UI-SKU');
  await page.getByLabel('Price, in cedis').fill('15.50');
  await page.getByLabel('In stock now').fill('2');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByText('Browser configured product', { exact: true }).waitFor();

  await page.goto(base + '/orders');
  await page.getByText(order.referenceNumber, { exact: true }).first().click();
  const invoicePanel = page.getByRole('region', { name: 'Commerce invoice' });
  await invoicePanel.getByText('Invoice ' + invoice.reference, { exact: true }).waitFor();
  await invoicePanel.getByText(/Verified payment/).waitFor();
  await page.getByRole('button', { name: 'Start packing', exact: true }).click();
  await invoicePanel.getByRole('button', { name: 'Mark preparation complete', exact: true }).click();
  await invoicePanel.getByText('Packing · Ready', { exact: true }).waitFor();

  await page.goto(base + '/dashboard');
  await page.getByRole('button', { name: 'Customer cases', exact: true }).click();
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
  console.log('PASS mobile Chromium owner product setup, invoice, packing and verified customer-case resolution');
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}
process.exit(0);
