import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  if (url.hostname !== '127.0.0.1' || !url.port || (name === 'DATABASE_URL' && !url.pathname.startsWith('/flowdesk_g1_'))) {
    throw new Error('Use disposable loopback fixtures');
  }
}
const bounded = promisify(execFile);
const archive = process.env.B4_PRIOR_BIN;
assert(archive && resolve(archive) !== resolve('.'), 'Set B4_PRIOR_BIN to the archived approved Batch 3 project');
const load = (file) => import(pathToFileURL(resolve(file)).href);
const { prisma } = await load('apps/api/dist/config/database.js');
const { disconnectRedis } = await load('apps/api/dist/config/redis.js');
const { createApp } = await load('apps/api/dist/app.js');
const { signAccessToken } = await load('apps/api/dist/services/auth/tokens.js');
const { recoverWorkflows } = await load('apps/api/dist/modules/workflows/workflow.worker.js');
const { outboundWorker } = await load('apps/api/dist/workers/outbound.worker.js');
const { outboundMessagesQueue } = await load('apps/api/dist/queues/outbound.queue.js');
const scope = await prisma.business.create({ data: { name: 'Synthetic rollback service', ownerName: 'Fixture',
  waPhoneNumberId: randomUUID(), waAccessToken: 'rollback-fixture-token' } });
const customer = await prisma.customer.create({ data: { businessId: scope.id, name: 'Synthetic rollback customer',
  waNumber: '233208400001', lastInboundAt: new Date() } });
const headers = { authorization: 'Bearer ' + signAccessToken({ businessId: scope.id, plan: 'BUSINESS' }, '15m') };
const app = await createApp();
const api = async (method, path, payload, status) => {
  const result = await app.inject({ method, url: '/api/v1/service-operations' + path, payload, headers });
  assert.equal(result.statusCode, status, result.body);
  return result.json().data;
};
try {
  await api('PUT', '/settings', { enabled: true, timeZone: 'Africa/Accra',
    hours: Array.from({ length: 7 }, (_, day) => ({ day, open: '08:00', close: '17:00' })), revision: 0 }, 200);
  const service = await api('POST', '/catalogue', { name: 'Rollback clinic', priceMinor: 4200, revision: 0, durationMinutes: 30, capacity: 1,
    rules: { category: 'CONSULTATION', location: 'Fixture clinic', payment: { kind: 'AFTER_SERVICE' } } }, 201);
  const startsAt = new Date();
  startsAt.setUTCDate(startsAt.getUTCDate() + 2);
  startsAt.setUTCHours(14, 0, 0, 0);
  const created = await api('POST', '/visits', { customerId: customer.id, serviceId: service.id, requestKey: randomUUID(),
    startsAt: startsAt.toISOString(), serviceRevision: 1, settingsRevision: 1 }, 201);
  const visit = () => prisma.serviceVisit.findUniqueOrThrow({ where: { appointmentId: created.appointmentId },
    include: { appointment: true, invoice: true, history: true, notices: true } });
  const workflow = () => prisma.workflow.findFirstOrThrow({ where: { businessId: scope.id, appointmentId: created.appointmentId } });
  const before = [await visit(), await workflow()];

  // Only health traffic reaches the old Fastify binary. Its server entry
  // point and schedulers stay quiesced for the entire rehearsal.
  const previous = await bounded(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    const { createApp } = await import('./apps/api/dist/app.js');
    const { prisma } = await import('./apps/api/dist/config/database.js');
    const { disconnectRedis } = await import('./apps/api/dist/config/redis.js');
    const prior = await createApp();
    const gateway = createServer(async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(503).end(); return; }
      const result = await prior.inject({ method: 'GET', url: '/health' });
      res.writeHead(result.statusCode).end(result.body);
    }).listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    try {
      const base = 'http://127.0.0.1:' + gateway.address().port;
      assert.equal((await fetch(base + '/health')).status, 200);
      assert.equal((await fetch(base + '/api/v1/appointments')).status, 503);
      assert.equal((await fetch(base + '/api/v1/webhook', { method: 'POST' })).status, 503);
      await assert.rejects(prisma.appointment.update({ where: { id: process.env.B4_VISIT }, data: { status: 'COMPLETED' } }), /Managed appointment/);
      console.log('Approved Batch 3 binary passed gated health and the managed appointment write was rejected.');
    } finally {
      gateway.closeAllConnections();
      await new Promise((done) => gateway.close(done));
      await prior.close();
      await prisma.$disconnect();
      await disconnectRedis();
    }
    process.exit(0);
  `], { cwd: archive, timeout: 30_000, env: { ...process.env, B4_VISIT: created.appointmentId } });
  process.stdout.write(previous.stdout);
  assert.deepEqual([await visit(), await workflow()], before);
  await recoverWorkflows(new Date());
  await recoverWorkflows(new Date(Date.now() + 3_000));
  assert.equal((await workflow()).reason, 'SERVICE_CONFIRMED');
  const after = await visit();
  assert.equal(after.state, 'CONFIRMED');
  assert.equal(after.invoiceId, before[0].invoiceId);
  assert.equal(after.history.length, 1);
  assert.equal(after.notices.filter((event) => event.kind === 'CONFIRMED' && event.sendId).length, 1);
  console.log('Current binary roll-forward reconciled one notification and preserved the reservation and invoice.');
} finally {
  await outboundWorker.close();
  await outboundMessagesQueue.close();
  await app.close();
  await prisma.$disconnect();
  await disconnectRedis();
}
process.exit(0);
