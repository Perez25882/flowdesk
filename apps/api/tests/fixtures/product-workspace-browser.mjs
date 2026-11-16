import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

setTimeout(() => process.exit(1), 360_000).unref();
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && (name === 'DATABASE_URL' ? url.pathname.startsWith('/flowdesk_g1_') : url.port !== '6379'));
}
const localFetch = globalThis.fetch;
const verificationCodes = new Map();
process.env.RESEND_API_KEY = 'synthetic-browser-mail-token';
process.env.RESEND_FROM_EMAIL = 'fixture@flowdesk.invalid';
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://api.resend.com' && url.pathname === '/emails') {
    const { to, subject } = JSON.parse(String(options?.body));
    const code = /^(\d{6}) is your Flowdesk code$/.exec(subject)?.[1];
    assert.ok(code && to.length === 1 && to[0].endsWith('@flowdesk.invalid'));
    verificationCodes.set(to[0], code);
    return Promise.resolve(Response.json({ id: 'synthetic-verification-mail' }));
  }
  assert.equal(url.hostname, '127.0.0.1', 'Only disposable local transport is allowed');
  return localFetch(input, options);
};
const load = (file) => import(pathToFileURL(resolve(file)).href);
const { chromium } = await load(process.env.B2_PLAYWRIGHT);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { startSSEFanout, stopSSEFanout } = await load('apps/api/dist/services/sse/sse.manager.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const localRequire = createRequire(pathToFileURL(resolve('apps/api/dist/app.js')));
const password = 'Local-fixture-product-browser!';
const passwordHash = await localRequire('bcrypt').hash(password, 4);

const app = await createApp();
await startSSEFanout();
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
  const loginPath = staff ? '/api/v1/staff/login' : '/api/v1/auth/login';
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === loginPath && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await responsePromise;
  assert.ok(response.ok(), `Login HTTP ${response.status()}`);
  await page.waitForURL('**/dashboard');
  return (await response.json()).data.accessToken;
}

async function register(page, name) {
  const email = `product-${randomUUID()}@flowdesk.invalid`;
  await page.goto(base + '/register');
  await page.locator('#businessName').fill(name);
  await page.locator('#ownerName').fill('Fixture owner');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  const [response, mail] = await Promise.all([
    page.waitForResponse((result) => new URL(result.url()).pathname === '/api/v1/auth/register' && result.request().method() === 'POST', { timeout: 45000 }),
    page.waitForResponse((result) => new URL(result.url()).pathname === '/api/v1/auth/verify-email/request' && result.request().method() === 'POST', { timeout: 45000 }),
    page.getByRole('button', { name: 'Create account', exact: true }).click(),
  ]).catch(async (error) => {
    console.error('Registration page ' + new URL(page.url()).pathname + ' alerts ' + JSON.stringify(await page.getByRole('alert').allTextContents()));
    throw error;
  });
  assert.equal(response.status(), 201);
  assert.equal((await mail.json()).data.delivered, true);
  const code = verificationCodes.get(email);
  assert.ok(code);
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.waitForURL('**/setup');
  const business = await prisma.business.findUniqueOrThrow({ where: { email } });
  assert.ok(business.emailVerifiedAt);
  return { email, business, token: (await response.json()).data.accessToken };
}

async function noOverflow(page, route) {
  assert.ok(await page.evaluate(() => {
    const main = document.querySelector('main');
    return document.documentElement.scrollWidth <= window.innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
  }), `${route} overflow at ${page.viewportSize().width}px`);
}

try {
  const owner = await openPage();
  const retail = await register(owner, 'Retail fixture');
  const customer = await prisma.customer.create({ data: { businessId: retail.business.id, waNumber: '233209100001',
    name: 'Retail fixture customer', lastInboundAt: new Date() } });
  const rider = await prisma.staff.create({ data: { businessId: retail.business.id, role: 'DELIVERY', name: 'Fixture rider',
    phone: '233209100003', passwordHash, inviteAcceptedAt: new Date() } });
  const operator = await prisma.staff.create({ data: { businessId: retail.business.id, role: 'OPERATIONS', name: 'Fixture inbox operator',
    phone: '233209100004', passwordHash, inviteAcceptedAt: new Date() } });
  const inbound = await prisma.message.create({ data: { businessId: retail.business.id, customerId: customer.id,
    waMessageId: 'fixture-' + randomUUID(), direction: 'INBOUND', body: 'Can you help with this order?', requiresReview: true } });
  await owner.getByRole('heading', { name: 'Business setup' }).waitFor();
  await owner.getByRole('radio', { name: /Retail and online sales/ }).focus();
  await owner.keyboard.press('Space');
  await owner.getByRole('button', { name: 'Save business profile' }).click();
  await owner.getByText('Business profile saved.').waitFor();
  await owner.reload();
  assert.ok(await owner.getByRole('radio', { name: /Retail and online sales/ }).isChecked());
  assert.equal(await owner.getByText('Connected and independently verified').count(), 0);

  const professional = await openPage();
  const service = await register(professional, 'Service fixture');
  await professional.getByRole('radio', { name: /Consultations and professional services/ }).check();
  await professional.getByRole('button', { name: 'Save business profile' }).click();
  await professional.getByText('Business profile saved.').waitFor();
  await professional.getByRole('link', { name: 'Open add services and prices' }).click();
  await professional.getByRole('heading', { name: 'Service setup' }).waitFor();
  assert.equal((await prisma.business.findUniqueOrThrow({ where: { id: service.business.id } })).bookingsEnabled, true);
  const crossTenant = await professional.request.get(base + `/api/v1/conversations/${customer.id}/context`,
    { headers: { authorization: 'Bearer ' + service.token } });
  assert.equal(crossTenant.status(), 404);
  console.log('Retail and service accounts verify synthetic email and reach setup. Cross-tenant inbox context returns 404.');

  await owner.goto(base + '/dashboard');
  const tabs = owner.getByRole('tablist', { name: 'Overview workspace' });
  await tabs.getByRole('tab', { name: 'Overview' }).focus();
  await owner.keyboard.press('ArrowRight');
  await owner.waitForURL((url) => url.pathname === '/dashboard' && url.searchParams.get('view') === 'work');
  assert.equal(await tabs.getByRole('tab', { name: 'Work center' }).getAttribute('aria-selected'), 'true');
  assert.equal(await owner.locator(':focus').innerText(), 'Work center');
  await owner.goto(base + `/messages?c=${customer.id}`);
  await owner.getByRole('region', { name: 'Conversation', exact: true }).getByText(inbound.body, { exact: true }).waitFor();
  console.log('Keyboard opens the work center and direct inbox navigation opens the tenant thread.');

  const staffPage = await openPage(1366, 768);
  await login(staffPage, operator.phone, true);
  await staffPage.goto(base + `/messages?c=${customer.id}`);
  await staffPage.getByRole('button', { name: 'Claim conversation' }).waitFor();
  await staffPage.getByText('Live', { exact: true }).waitFor();
  const ownership = owner.getByRole('region', { name: 'Conversation assignment and read state' });
  await owner.getByText('Manage assignment', { exact: true }).click();
  await owner.getByLabel('Responsible staff member').selectOption(operator.id);
  await owner.getByRole('button', { name: 'Save assignment' }).click();
  await staffPage.getByText('Assigned to Fixture inbox operator', { exact: true }).waitFor({ timeout: 8000 });
  await staffPage.getByLabel('Filter by assignment', { exact: true }).selectOption('mine');
  await staffPage.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: /Retail fixture customer/ }).waitFor();
  await ownership.getByRole('button', { name: 'Mark read', exact: true }).focus();
  await owner.keyboard.press('Enter');
  await ownership.getByRole('button', { name: 'Mark unread', exact: true }).waitFor();
  await staffPage.getByRole('button', { name: 'Mark read', exact: true }).waitFor();
  await owner.reload();
  await ownership.getByRole('button', { name: 'Mark unread', exact: true }).click();
  await ownership.getByText('Marked unread', { exact: true }).waitFor();
  await staffPage.getByRole('button', { name: 'Return to shared queue' }).click();
  await ownership.getByText('Unassigned', { exact: true }).waitFor({ timeout: 8000 });
  await staffPage.getByRole('button', { name: 'Claim conversation' }).waitFor();
  await staffPage.route('**/api/v1/conversations/*/assignment', async (route) => {
    await prisma.staff.update({ where: { id: operator.id }, data: { role: 'DELIVERY' } });
    await route.continue();
  });
  const revoked = staffPage.waitForResponse((response) => response.url().endsWith('/assignment') && response.request().method() === 'PUT');
  await staffPage.getByRole('button', { name: 'Claim conversation' }).click();
  assert.equal((await revoked).status(), 403);
  await staffPage.getByRole('region', { name: 'Conversation', exact: true }).getByRole('alert').waitFor();
  assert.equal((await prisma.inboxThread.findUniqueOrThrow({ where: { customerId: customer.id } })).assignedStaffId, null);
  await staffPage.close();
  console.log('Inbox assignment and individual read positions survived refresh. SSE refreshed both sessions. Role revocation prevented a pending claim.');

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
  await form.getByLabel('Customer').selectOption(customer.id);
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
  const newOrder = owner.getByRole('button', { name: 'New order', exact: true });
  await newOrder.focus();
  await owner.keyboard.press('Enter');
  const order = owner.getByRole('dialog', { name: 'New order' });
  await order.waitFor();
  for (let tab = 0; tab < 10; tab++) {
    await owner.keyboard.press('Tab');
    assert.ok(await owner.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), 'Dialog focus escaped');
  }
  await owner.keyboard.press('Escape');
  await order.waitFor({ state: 'hidden' });
  assert.ok(await newOrder.evaluate((node) => node === document.activeElement), 'Order dialog did not restore focus');
  await owner.keyboard.press('Enter');
  await order.getByRole('radio', { name: 'Existing', exact: true }).click();
  await order.getByLabel('Choose a customer').selectOption(customer.id);
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

  for (const [page, expected] of [[owner, 1], [professional, 0]]) {
    await page.goto(base + '/reports');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const data = await readFile(await (await download).path(), 'utf8');
    assert.ok(data.includes(`"Total",0.00,${expected}`), 'The report download disagrees with current tenant orders');
    assert.ok(!data.includes(customer.waNumber), 'A report exposed a customer number');
  }
  await actor.goto(base + '/reports');
  await actor.getByRole('heading', { name: 'Access restricted' }).waitFor();
  assert.equal((await actor.request.get(base + '/api/v1/reports/export.csv?days=30', {
    headers: { authorization: 'Bearer ' + riderToken },
  })).status(), 403);
  console.log('Two actual CSV exports contained only their tenant totals. A delivery session could not open or export reports.');

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

  if (process.env.B5_CONTROL_AUDIT) {
    const scans = [];
    const publicPage = await openPage();
    for (const [width, height] of [[390, 844], [768, 1024], [1366, 768]]) {
      const routes = [
        [publicPage, '/register'], [publicPage, '/login'], [publicPage, '/forgot-password'],
        [owner, '/setup'], [owner, '/dashboard'], [owner, '/dashboard?view=work'], [owner, '/messages'],
        [owner, '/messages?view=cases'], [owner, '/messages?c=' + customer.id], [owner, '/customers'],
        [owner, '/customers/' + customer.id], [owner, '/products'], [owner, '/orders'], [owner, '/orders?workspace=quotes'],
        [owner, '/payments?view=invoices'], [professional, '/bookings?view=operations&calendar=week'],
        [owner, '/staff'], [owner, '/reports'], [owner, '/settings?section=assistant'],
      ];
      for (const [page, path] of routes) {
        const sample = { width, path: path.replace(customer.id, '<customer>'), role: page === publicPage ? 'public' : 'owner',
          profile: page === professional ? 'PROFESSIONAL_SERVICES' : page === owner ? 'ONLINE_RETAIL' : null };
        try {
          await page.setViewportSize({ width, height });
          await page.goto(base + path);
          const heading = page.locator('h1').first();
          await heading.waitFor({ state: 'attached', timeout: 8000 });
          const headingVisible = await heading.isVisible();
          const overflow = await noOverflow(page, path).then(() => false, () => true);
          const state = await page.evaluate(() => [...(document.querySelector('main') ?? document).querySelectorAll('button, a[href], input, select, textarea, summary')]
          .filter((element) => element.getClientRects().length && !element.closest('details:not([open]) > :not(summary)')).map((element) => ({
            element: element.localName, label: element.getAttribute('aria-label') ?? element.labels?.[0]?.textContent?.trim() ?? element.textContent.trim().replace(/\s+/g, ' '),
            enabled: !element.matches(':disabled,[aria-disabled="true"]'), disposition: 'BLOCKED',
          })));
          if (process.env.B5_AXE) await page.addScriptTag({ path: process.env.B5_AXE });
          const violations = process.env.B5_AXE ? await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations
            .map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) }))) : [];
          scans.push({ ...sample, headingVisible, overflow, controls: state, violations });
        } catch (error) {
          scans.push({ ...sample, error: error.name, controls: [], violations: [] });
        }
        await writeFile(process.env.B5_CONTROL_AUDIT, JSON.stringify(scans, null, 2) + '\n');
      }
    }
    await writeFile(process.env.B5_CONTROL_AUDIT, JSON.stringify(scans, null, 2) + '\n');
    const failures = scans.filter((sample) => sample.violations.length || sample.overflow || !sample.headingVisible || sample.error);
    console.log(`Control audit ${scans.length} route/viewport samples, ${failures.length} samples with layout, Axe or navigation findings`);
    if (failures.length) process.exitCode = 1;
    await publicPage.close();
    await owner.goto(base + '/payments?view=invoices');
  }

  await owner.context().clearCookies();
  await owner.reload();
  await owner.waitForURL('**/login');
  await owner.locator('#email').fill(retail.email);
  await owner.locator('#password').fill(password);
  await owner.getByRole('button', { name: 'Sign in', exact: true }).click();
  await owner.waitForURL((url) => url.pathname === '/payments' && url.searchParams.get('view') === 'invoices');
  const response = await owner.request.get(base + '/api/v1/dashboard/overview', { headers: { authorization: 'Bearer ' + retail.token } });
  assert.equal(response.status(), 200);
  console.log('Missing refresh session returns the browser to sign-in with its internal return route.');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => {
    gateway.close(done);
    gateway.closeAllConnections();
  });
  const { outboundMessagesQueue } = await load('apps/api/dist/queues/outbound.queue.js');
  app.server.closeAllConnections();
  await app.close();
  await outboundMessagesQueue.close();
  await prisma.$disconnect();
  await stopSSEFanout();
  await disconnectRedis();
}

process.exit(process.exitCode ?? 0);
