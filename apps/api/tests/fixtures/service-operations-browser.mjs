import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

setTimeout(() => process.exit(1), 240_000).unref();
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  if (url.hostname !== '127.0.0.1' || !url.port || (name === 'DATABASE_URL' && !url.pathname.startsWith('/flowdesk_g1_')) ||
      (name === 'REDIS_URL' && url.port === '6379')) throw new Error('Use disposable IPv4 fixtures');
}
const load = (file) => import(pathToFileURL(resolve(file)).href);
const paySecret = 'sk_test_synthetic_service_browser';
process.env.PAYSTACK_SECRET_KEY = paySecret;
process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_synthetic_service_browser';
const charges = new Map();
const initial = [];
const internalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize') {
    const body = JSON.parse(String(options.body));
    initial.push({ ...body, metadata: JSON.parse(body.metadata) });
    return Response.json({ status: true, data: { reference: body.reference, authorization_url: 'https://checkout.invalid/' + body.reference,
      access_code: 'local-fixture' } });
  }
  if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/')) {
    return Response.json({ status: true, data: charges.get(url.pathname.split('/').at(-1)) });
  }
  if (url.hostname === '127.0.0.1') return internalFetch(input, options);
  throw new Error('Blocked non-loopback transport in service browser fixture');
};

const { chromium } = await import(pathToFileURL(process.env.B2_PLAYWRIGHT).href);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { recoverWorkflows } = await load('apps/api/dist/modules/workflows/workflow.worker.js');
const { drainPaystackReceipts } = await load('apps/api/dist/modules/payments/paystack-settlement.js');
const { dispatchTextReceipts, openTextReceiptQueue } = await load('apps/api/dist/workers/text-receipt.worker.js');
const { outboundWorker } = await load('apps/api/dist/workers/outbound.worker.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const localRequire = createRequire(pathToFileURL(resolve('apps/api/dist/app.js')));
const password = 'Local-fixture-service-2026!';
const passwordHash = await localRequire('bcrypt').hash(password, 4);
const email = 'service-' + randomUUID() + '@flowdesk.invalid';
const business = await prisma.business.create({ data: { name: 'Synthetic service browser', ownerName: 'Fixture owner',
  email, passwordHash, emailVerifiedAt: new Date(), bookingsEnabled: true, waPhoneNumberId: randomUUID(), waAccessToken: 'fixture-local-token',
  paystackSubaccountCode: 'ACCT_' + randomUUID() } });
const customer = await prisma.customer.create({ data: { businessId: business.id,
  waNumber: '233209011101', name: 'Browser service customer', lastInboundAt: new Date() } });
const staff = await prisma.staff.create({ data: { businessId: business.id, name: 'Browser technician',
  phone: '233209011123', role: 'OPERATIONS', passwordHash, inviteAcceptedAt: new Date() } });
await prisma.workflowSettings.create({ data: { businessId: business.id, profile: 'APPOINTMENT', enabled: true } });
await prisma.$executeRaw`UPDATE whatsapp_phone_ownership SET "startedAt" = ${new Date(Date.now() - 60_000)} WHERE "businessId" = ${business.id}`;

const app = await createApp();
const origin = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
const gateway = releaseGateway(origin, resolve('apps/web/dist'));
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const url = 'http://127.0.0.1:' + gateway.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.B2_CHROMIUM, args: ['--disable-background-networking'] });
const queue = openTextReceiptQueue();
await queue.ready();

async function waitFor(read, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('Timed out awaiting ' + description);
}

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(22_000);
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(url + '/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  console.log('Owner signed in');
  await page.goto(url + '/bookings');
  await page.getByRole('tab', { name: 'Service operations' }).click();
  await page.getByLabel('Business time zone').fill('Africa/Accra');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getUTCDay()];
  if (['Sat', 'Sun'].includes(weekday)) await page.getByRole('button', { name: 'Add ' + weekday + ' hours' }).click();
  await page.getByLabel(weekday + ' opens').fill('00:00');
  await page.getByLabel(weekday + ' closes').fill('23:59');
  await page.getByLabel('Reminder minutes before appointment').fill('15');
  await page.getByRole('button', { name: 'Save business hours' }).click();
  await page.getByText('Add staff or equipment', { exact: true }).click();
  await page.getByLabel('Resource name').fill('Workshop technician');
  await page.getByLabel('Staff member', { exact: true }).selectOption(staff.id);
  await page.getByRole('button', { name: 'Save resource' }).click();
  await page.getByText('Workshop technician', { exact: true }).waitFor();
  await page.getByText('Add a managed service', { exact: true }).click();
  await page.getByLabel('Service name').fill('Browser repair');
  await page.getByLabel('Service category').selectOption('REPAIR');
  await page.getByLabel('Service location').fill('Fixture workshop');
  await page.getByLabel('Price (GHS)').fill('50');
  await page.getByLabel('Minimum notice minutes').fill('0');
  await page.getByLabel('Payment policy').selectOption('FIXED');
  await page.getByLabel('Deposit (GHS)').fill('20');
  await page.getByRole('checkbox', { name: 'Workshop technician' }).check();
  await page.getByLabel('Execution stages (one per line)').fill('Tested and handed off');
  await page.getByLabel('Require manager approval').check();
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  const service = await waitFor(() => prisma.service.findFirst({ where: { businessId: business.id, name: 'Browser repair' } }), 'configured service');
  console.log('Browser configured hours, staff and repair catalogue');
  const message = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: business.waPhoneNumberId }, messages: [{ id: 'wamid.' + randomUUID(), from: customer.waNumber,
      timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'SERVICE Browser repair | Customer confirmed faulty part' } }],
  } }] }] });
  const response = await app.inject({ method: 'POST', url: '/api/v1/webhook', payload: message, headers: {
    'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', process.env.META_WEBHOOK_SECRET).update(message).digest('hex'),
  } });
  if (response.statusCode !== 200) throw new Error('Signed service inquiry failed');
  await dispatchTextReceipts(queue.enqueue, new Date(), business.id);
  await recoverWorkflows(new Date());
  await recoverWorkflows(new Date(Date.now() + 3_000));
  await page.getByText('Customer confirmed faulty part · new', { exact: true }).click();
  await page.getByLabel('Requested service').selectOption(service.id);
  await page.getByLabel('Responsible staff').selectOption(staff.id);
  await page.getByLabel('Qualification notes').fill('Owner verified repair scope');
  await page.getByRole('button', { name: 'Save qualification' }).click();
  await page.getByLabel('Qualified lead', { exact: true }).selectOption({ label: 'Customer confirmed faulty part' });
  await page.getByRole('button', { name: 'Find available times' }).click();
  const times = page.getByLabel('Available times');
  await times.waitFor();
  await times.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Reserve appointment' }).click();
  const created = await waitFor(() => prisma.serviceVisit.findFirst({ where: { businessId: business.id }, include: { appointment: true } }), 'reserved appointment');
  console.log('Owner qualified a signed lead and held its booking');
  if (created.state !== 'HELD' || created.assignedStaffId !== staff.id) throw new Error('Expected held visit and current worker');
  await page.getByLabel('Appointment action').selectOption('APPROVE');
  await page.getByLabel('Evidence or staff notes').fill('Owner approved this repair');
  await page.getByRole('button', { name: 'Record appointment action' }).click();
  await page.getByText('View invoice and deposit', { exact: true }).click();
  await page.getByRole('button', { name: 'Send payment link' }).click();
  await waitFor(() => initial.find((item) => item.metadata.flowdeskInvoiceId === created.invoiceId), 'exact checkout request');
  const charge = initial.find((item) => item.metadata.flowdeskInvoiceId === created.invoiceId);
  if (charge.amount !== 2000) throw new Error('Expected exact GHS 20 deposit');
  await page.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  await page.reload();
  await page.getByRole('tab', { name: 'Service operations' }).click();
  await page.getByText('View invoice and deposit', { exact: true }).click();
  await page.getByRole('link', { name: 'Open existing payment link' }).waitFor();
  if (initial.length !== 1) throw new Error('Refresh repeated the checkout side effect');
  const verified = { id: 99001, reference: charge.reference, amount: charge.amount, currency: 'GHS', status: 'success', domain: 'test',
    paid_at: new Date().toISOString(), channel: 'card', subaccount: { subaccount_code: charge.subaccount }, metadata: charge.metadata };
  charges.set(charge.reference, verified);
  const event = JSON.stringify({ event: 'charge.success', data: verified });
  const callback = await app.inject({ method: 'POST', url: '/api/v1/webhooks/paystack', payload: event, headers: {
    'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', paySecret).update(event).digest('hex'),
  } });
  if (callback.statusCode !== 200) throw new Error('Signed synthetic settlement failed');
  await drainPaystackReceipts(business.id);
  await recoverWorkflows(new Date());
  await waitFor(async () => (await prisma.serviceVisit.findUnique({ where: { appointmentId: created.appointmentId } })).state === 'CONFIRMED', 'held deposit confirmed');
  console.log('Exact signed settlement confirmed the booking');

  const worker = await browser.newPage({ viewport: { width: 390, height: 844 } });
  worker.setDefaultTimeout(22_000);
  await worker.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await worker.goto(url + '/login');
  await worker.getByRole('tab', { name: 'Staff member' }).click();
  await worker.locator('#phone').fill(staff.phone);
  await worker.locator('#password').fill(password);
  await worker.getByRole('button', { name: 'Sign in', exact: true }).click();
  await worker.waitForURL('**/dashboard');
  await worker.goto(url + '/bookings');
  await worker.getByText('Browser repair · Browser service customer', { exact: true }).waitFor();
  if (await worker.getByText('View invoice and deposit').count()) throw new Error('Assigned work disclosed payment controls');
  for (const action of ['ACKNOWLEDGE', 'CHECK_IN', 'START', 'STAGE', 'COMPLETE']) {
    const response = worker.waitForResponse((candidate) => candidate.url().endsWith('/actions') && candidate.request().method() === 'POST');
    await worker.getByLabel('Appointment action').selectOption(action);
    await worker.getByLabel('Evidence or staff notes').fill('Staff observed ' + action.toLowerCase());
    await worker.getByRole('button', { name: 'Record appointment action' }).click();
    if (!(await response).ok()) throw new Error('Staff operation failed at ' + action);
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Service operations' }).click();
  await page.getByText('Appointment history', { exact: true }).click();
  await page.getByText(/Staff observed complete/).waitFor();
  for (const actor of [page, worker]) {
    if (await actor.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Unexpected mobile overflow');
  }
  const final = await prisma.serviceVisit.findUniqueOrThrow({ where: { appointmentId: created.appointmentId }, include: { history: true } });
  if (final.state !== 'COMPLETED' || final.stageIndex !== 1 || !final.history.some((event) => event.action === 'COMPLETE' && event.staffId === staff.id) ||
      await prisma.payment.count({ where: { invoiceId: created.invoiceId } }) !== 1) throw new Error('Browser workflow final evidence is incomplete');
  console.log('Mobile Chromium preserved one checkout across refresh, confirmed the exact deposit, and recorded assigned repair completion and owner history.');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await queue.close();
  await outboundWorker.close();
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}
process.exit(0);
