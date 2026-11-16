import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

setTimeout(() => process.exit(1), 240_000).unref();
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && (name === 'DATABASE_URL' ? url.pathname.startsWith('/flowdesk_g1_') : url.port !== '6379'));
}
const localFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.hostname, '127.0.0.1', 'Only disposable local transport is allowed');
  return localFetch(input, options);
};
const load = (file) => import(pathToFileURL(resolve(file)).href);
const { chromium } = await load(process.env.B2_PLAYWRIGHT);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const localRequire = createRequire(pathToFileURL(resolve('apps/api/dist/app.js')));
const password = 'Local-fixture-product-browser!';
const passwordHash = await localRequire('bcrypt').hash(password, 4);

async function tenant(name, number) {
  const email = `product-${randomUUID()}@flowdesk.invalid`;
  const business = await prisma.business.create({ data: { name, ownerName: 'Fixture owner', email, passwordHash, emailVerifiedAt: new Date() } });
  const customer = await prisma.customer.create({ data: { businessId: business.id, waNumber: number, name: name + ' customer', lastInboundAt: new Date() } });
  return { email, business, customer };
}

const retail = await tenant('Retail fixture', '233209100001');
const service = await tenant('Service fixture', '233209100002');
const rider = await prisma.staff.create({ data: { businessId: retail.business.id, role: 'DELIVERY', name: 'Fixture rider',
  phone: '233209100003', passwordHash, inviteAcceptedAt: new Date() } });
const inbound = await prisma.message.create({ data: { businessId: retail.business.id, customerId: retail.customer.id,
  waMessageId: 'fixture-' + randomUUID(), direction: 'INBOUND', body: 'Can you help with this order?', requiresReview: true } });
const app = await createApp();
const origin = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
const gateway = releaseGateway(origin, resolve('apps/web/dist'));
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const base = 'http://127.0.0.1:' + gateway.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.B2_CHROMIUM,
  args: ['--disable-background-networking'] });

async function openPage(width = 390, height = 844) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  page.setDefaultTimeout(16_000);
  page.on('pageerror', (error) => console.log('Browser page error ' + error.message));
  return page;
}

async function login(page, identity, staff = false) {
  await page.goto(base + '/login');
  if (staff) await page.getByRole('tab', { name: 'Staff member' }).click();
  await page.locator(staff ? '#phone' : '#email').fill(identity);
  await page.locator('#password').fill(password);
  const responsePromise = page.waitForResponse((response) => /\/auth\/(login|staff-login|staff\/login)$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await responsePromise;
  assert.ok(response.ok(), `Login HTTP ${response.status()}`);
  await page.waitForURL('**/dashboard');
  return (await response.json()).data.accessToken;
}

async function noOverflow(page, route) {
  assert.ok(await page.evaluate(() => {
    const main = document.querySelector('main');
    return document.documentElement.scrollWidth <= window.innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
  }), `${route} overflow at ${page.viewportSize().width}px`);
}

try {
  const owner = await openPage();
  const ownerToken = await login(owner, retail.email);
  await owner.goto(base + '/setup');
  await owner.getByRole('heading', { name: 'Business setup' }).waitFor();
  await owner.getByRole('radio', { name: /Retail and online sales/ }).focus();
  await owner.keyboard.press('Space');
  await owner.getByRole('button', { name: 'Save business profile' }).click();
  await owner.getByText('Business profile saved.').waitFor();
  await owner.reload();
  assert.ok(await owner.getByRole('radio', { name: /Retail and online sales/ }).isChecked());
  assert.equal(await owner.getByText('Connected and independently verified').count(), 0);

  const professional = await openPage();
  const serviceToken = await login(professional, service.email);
  await professional.goto(base + '/setup');
  await professional.getByRole('radio', { name: /Consultations and professional services/ }).check();
  await professional.getByRole('button', { name: 'Save business profile' }).click();
  await professional.getByText('Business profile saved.').waitFor();
  await professional.getByRole('link', { name: 'Open add services and prices' }).click();
  await professional.getByRole('heading', { name: 'Service setup' }).waitFor();
  assert.equal((await prisma.business.findUniqueOrThrow({ where: { id: service.business.id } })).bookingsEnabled, true);
  const crossTenant = await professional.request.get(base + `/api/v1/conversations/${retail.customer.id}/context`,
    { headers: { authorization: 'Bearer ' + serviceToken } });
  assert.equal(crossTenant.status(), 404);
  console.log('Retail and service setup persist across refresh. Cross-tenant inbox context returns 404.');

  await owner.goto(base + '/dashboard');
  const tabs = owner.getByRole('tablist', { name: 'Overview workspace' });
  await tabs.getByRole('tab', { name: 'Overview' }).focus();
  await owner.keyboard.press('ArrowRight');
  await owner.waitForURL((url) => url.pathname === '/dashboard' && url.searchParams.get('view') === 'work');
  assert.equal(await tabs.getByRole('tab', { name: 'Work center' }).getAttribute('aria-selected'), 'true');
  assert.equal(await owner.locator(':focus').innerText(), 'Work center');
  await owner.goto(base + `/messages?c=${retail.customer.id}`);
  await owner.getByRole('region', { name: 'Conversation', exact: true }).getByText(inbound.body, { exact: true }).waitFor();
  console.log('Keyboard opens the work center and direct inbox navigation opens the tenant thread.');

  const actor = await openPage();
  const riderToken = await login(actor, rider.phone, true);
  await actor.goto(base + '/payments?view=invoices');
  await actor.getByRole('heading', { name: 'Access restricted' }).waitFor();
  const finance = await actor.request.get(base + '/api/v1/commerce/invoices', { headers: { authorization: 'Bearer ' + riderToken } });
  assert.equal(finance.status(), 403);
  const overview = await actor.request.get(base + '/api/v1/dashboard/overview', { headers: { authorization: 'Bearer ' + riderToken } });
  assert.equal((await overview.json()).data.money, null);
  console.log('Delivery staff restriction verified in the UI and API.');

  await owner.goto(base + '/payments?view=invoices');
  await owner.getByRole('button', { name: 'New standalone invoice' }).click();
  const form = owner.getByRole('form', { name: 'New invoice' });
  await form.getByLabel('Customer').selectOption(retail.customer.id);
  await form.getByLabel('Due date').fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await form.getByLabel('Description').fill('Interrupted request fixture');
  await form.getByLabel('Unit price (GHS)').fill('12.35');
  let posted = 0;
  await owner.route('**/api/v1/commerce/invoices', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted++;
    await delay(350);
    assert.equal((await route.fetch()).status(), 201);
    await route.abort('timedout');
  });
  await form.getByRole('button', { name: 'Save draft' }).evaluate((button) => { button.click(); button.click(); });
  await owner.getByText('Your invoice was saved.').waitFor();
  await owner.reload();
  await owner.getByRole('button', { name: 'Open saved invoice' }).click();
  await owner.getByRole('region', { name: 'Standalone invoice' }).getByText(/Interrupted request fixture/).waitFor();
  assert.equal(posted, 1);
  assert.equal(await prisma.commerceInvoice.count({ where: { businessId: retail.business.id } }), 1);
  console.log('Lost invoice response, duplicate click and browser refresh recover the one committed draft.');

  await owner.goto(base + '/orders');
  await owner.getByRole('button', { name: 'New order', exact: true }).click();
  const order = owner.getByRole('dialog', { name: 'New order' });
  await order.getByRole('radio', { name: 'Existing', exact: true }).click();
  await order.getByLabel('Choose a customer').selectOption(retail.customer.id);
  await order.getByRole('button', { name: 'Type it out', exact: true }).click();
  await order.getByLabel(/Item 1 description/i).fill('Interrupted manual order');
  let ordersPosted = 0;
  await owner.route('**/api/v1/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ordersPosted++;
    await delay(350);
    assert.equal((await route.fetch()).status(), 201);
    await route.abort('timedout');
  });
  await order.getByRole('button', { name: 'Create order', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await order.getByText('Your order was saved.').waitFor();
  await owner.reload();
  await owner.getByRole('button', { name: 'Open saved order', exact: true }).click();
  await owner.getByRole('dialog').getByText('Interrupted manual order', { exact: true }).waitFor();
  assert.equal(ordersPosted, 1);
  assert.equal(await prisma.order.count({ where: { businessId: retail.business.id } }), 1);
  console.log('Lost manual order response and refresh recover the one committed order.');

  await owner.route('**/api/v1/dashboard/overview', (route) => route.fulfill({ status: 503, body: '{}' }));
  await owner.goto(base + '/dashboard');
  await owner.getByText('The latest business figures could not load.').waitFor();
  await owner.unroute('**/api/v1/dashboard/overview');
  await owner.getByRole('button', { name: 'Try again' }).click();
  await owner.getByRole('region', { name: 'Business activity' }).waitFor();

  for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1366, 768], [1920, 1080]]) {
    await owner.setViewportSize({ width, height });
    for (const path of ['/dashboard', '/setup', '/orders', '/messages', '/payments?view=invoices']) {
      await owner.goto(base + path);
      await owner.locator('main h1').waitFor();
      await noOverflow(owner, path);
    }
  }
  console.log('25 desktop, tablet and mobile layout checks passed from 320px to 1920px.');
  if (process.env.B5_AXE) {
    for (const path of ['/dashboard', '/setup', '/orders', '/messages', '/payments?view=invoices']) {
      await owner.goto(base + path);
      await owner.locator('main h1').waitFor();
      await owner.addScriptTag({ path: process.env.B5_AXE });
      const violations = await owner.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations
        .map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) })));
      console.log('Axe ' + path + ' ' + JSON.stringify(violations));
      if (violations.length) process.exitCode = 1;
    }
  }

  await owner.context().clearCookies();
  await owner.reload();
  await owner.waitForURL('**/login');
  await owner.locator('#email').fill(retail.email);
  await owner.locator('#password').fill(password);
  await owner.getByRole('button', { name: 'Sign in', exact: true }).click();
  await owner.waitForURL((url) => url.pathname === '/payments' && url.searchParams.get('view') === 'invoices');
  const response = await owner.request.get(base + '/api/v1/dashboard/overview', { headers: { authorization: 'Bearer ' + ownerToken } });
  assert.equal(response.status(), 200);
  console.log('Missing refresh session returns the browser to sign-in with its internal return route.');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  const { outboundMessagesQueue } = await load('apps/api/dist/queues/outbound.queue.js');
  await outboundMessagesQueue.close();
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}
