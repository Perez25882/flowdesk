import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
setTimeout(() => process.exit(1), 75_000).unref();
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const fixture = new URL(process.env[name]);
  if (fixture.hostname !== '127.0.0.1' || !fixture.port || (name === 'DATABASE_URL' && !fixture.pathname.startsWith('/flowdesk_g1_')) ||
      (name === 'REDIS_URL' && fixture.port === '6379')) throw new Error('Use disposable IPv4 fixtures');
}
const load = (file) => import(pathToFileURL(resolve(root, file)).href);
const { chromium } = await import(pathToFileURL(process.env.B2_PLAYWRIGHT).href);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { admitWorkflow } = await load('apps/api/dist/modules/workflows/workflow.store.js');
const { recoverWorkflows } = await load('apps/api/dist/modules/workflows/workflow.worker.js');
const { releaseGateway } = await load('apps/api/scripts/release-gateway.mjs');
const require = createRequire(pathToFileURL(resolve(root, 'apps/api/dist/app.js')));
const email = 'work-center-' + randomUUID() + '@flowdesk.invalid';
const password = 'Fixture-local-2026!';
const business = await prisma.business.create({data: {
  name: 'Synthetic owner shop', ownerName: 'Synthetic owner', email, emailVerifiedAt: new Date(),
  passwordHash: await require('bcrypt').hash(password, 4),
}});
const customer = await prisma.customer.create({data: {
  businessId: business.id, waNumber: '233209777777', name: 'Synthetic customer', lastInboundAt: new Date(),
}});
const message = await prisma.message.create({data: {
  businessId: business.id, customerId: customer.id, waMessageId: randomUUID(),
  direction: 'INBOUND', type: 'TEXT', intent: 'STATUS_CHECK', processed: true, body: 'Where is my order FD-80808?',
}});
await prisma.order.create({data: { businessId: business.id, customerId: customer.id,
  referenceNumber: 'FD-80808', rawMessage: 'fixture', status: 'CONFIRMED' }});
await prisma.workflowSettings.create({data: {businessId: business.id, enabled: true, profile: 'ONLINE_RETAIL'}});
await prisma.$transaction((tx) => admitWorkflow(tx, {
  businessId: business.id, customerId: customer.id, messageId: message.id, receiptId: randomUUID(),
  phoneNumberId: 'browser-fixture', body: message.body, replyTo: null,
}, new Date()));
await recoverWorkflows(new Date());
await recoverWorkflows(new Date(Date.now() + 3_000));

const app = await createApp();
const api = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
const gateway = releaseGateway(api, resolve(root, 'apps/web/dist'));
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const browser = await chromium.launch({headless: true, executablePath: process.env.B2_CHROMIUM, args: ['--disable-background-networking']});
try {
  const page = await browser.newPage({viewport: {width: 390, height: 844}});
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:' + gateway.address().port + '/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('tab', { name: 'Work center' }).click();
  await page.getByRole('heading', {name: 'Work center'}).waitFor();
  await page.getByText('Synthetic customer').first().waitFor();
  await page.getByRole('button', {name: 'View', exact: true}).click();
  const details = page.getByRole('region', { name: 'Work details' });
  await details.getByRole('link', { name: 'FD-80808', exact: true }).waitFor();
  await details.getByText('This action sends the customer a verified order status.', { exact: false }).waitFor();
  await page.getByRole('button', {name: 'Approve reply'}).click();
  await page.getByText('Owner approved the update').waitFor();
  const workflow = await prisma.workflow.findUniqueOrThrow({where: {businessId_sourceId: {businessId: business.id, sourceId: message.id}},
    include: {approval: true}});
  if (workflow.approval?.decision !== 'APPROVED') throw new Error('Browser approval was not persisted');
  console.log('PASS real owner login, mobile work center, tenant workflow history, and persisted approval');
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}

process.exit(0);
