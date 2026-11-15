import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;
const fixtureOnly = database || cache ? describe : describe.skip;

fixtureOnly('Batch 2 workflow recovery and permissions with PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let store: typeof import('../src/modules/workflows/workflow.store.js');
  let worker: typeof import('../src/modules/workflows/workflow.worker.js');
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let closeRedis: () => Promise<void>;

  beforeAll(async () => {
    if (![database, cache].every((url) => url && new URL(url).hostname === '127.0.0.1')) {
      throw new Error('Use disposable loopback PostgreSQL and Redis');
    }
    process.env.DATABASE_URL = database;
    process.env.REDIS_URL = cache;
    ({ prisma } = await import('../src/config/database.js'));
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    store = await import('../src/modules/workflows/workflow.store.js');
    worker = await import('../src/modules/workflows/workflow.worker.js');
    app = await (await import('../src/app.js')).createApp();
    closeRedis = (await import('../src/config/redis.js')).disconnectRedis;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await closeRedis?.();
  });

  async function setup() {
    const business = await prisma.business.create({ data: { name: 'Synthetic workflow shop', ownerName: 'Fixture' } });
    const customer = await prisma.customer.create({ data: {
      businessId: business.id, waNumber: '233201111111', lastInboundAt: new Date(),
    } });
    const message = await prisma.message.create({ data: {
      businessId: business.id, customerId: customer.id, waMessageId: 'fixture-' + randomUUID(),
      direction: 'INBOUND', body: 'Where is my order FD-55555?', processed: true, intent: 'STATUS_CHECK',
    } });
    const order = await prisma.order.create({ data: {
      businessId: business.id, customerId: customer.id, referenceNumber: 'FD-55555', rawMessage: 'fixture', status: 'CONFIRMED',
    } });
    await prisma.workflowSettings.create({ data: { businessId: business.id, profile: 'ONLINE_RETAIL', enabled: true } });
    await prisma.$transaction((tx) => store.admitWorkflow(tx, {
      businessId: business.id, customerId: customer.id, messageId: message.id, receiptId: randomUUID(), phoneNumberId: 'fixture',
      body: message.body, replyTo: null,
    }, new Date()));
    const row = await prisma.workflow.findUniqueOrThrow({ where: { businessId_sourceId: { businessId: business.id, sourceId: message.id } } });
    const read = () => prisma.workflow.findUniqueOrThrow({ where: { id: row.id }, include: { evidence: true, approval: true } });
    const headers = { authorization: 'Bearer ' + sign({ businessId: business.id, plan: 'BUSINESS' }, '15m') };
    return { row, order, read, headers };
  }

  it('rolls back an interrupted worker and records one transition from competing schedulers', async () => {
    const { row, read } = await setup();
    await prisma.workflow.update({ where: { id: row.id }, data: { dueAt: new Date(0) } });
    const child = fork(fileURLToPath(new URL('./fixtures/batch-workflow-crash.mjs', import.meta.url)), [row.id], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    try {
      const locked = once(child, 'message', { signal: AbortSignal.timeout(15_000) });
      const [status] = await locked;
      expect(status).toBe('locked');
      expect((await read()).evidence.map((event) => event.eventKey)).not.toContain('crashed-attempt');
      await worker.recoverWorkflows(new Date());
      expect((await read()).state).toBe('CREATED');
    } finally {
      child.kill();
      await exited;
    }
    await expect.poll(async () => {
      await Promise.all(Array.from({ length: 4 }, () => worker.recoverWorkflows(new Date())));
      return (await read()).state;
    }).toBe('RUNNING');
    const result = await read();
    expect(result.state).toBe('RUNNING');
    expect(result.evidence.filter((event) => event.eventType === 'PROCESSING')).toHaveLength(1);
    expect(result.evidence.map((event) => event.eventKey)).not.toContain('crashed-attempt');
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    expect((await read()).state).toBe('WAITING_OWNER_APPROVAL');
  }, 30_000);

  it('rejects stale approval evidence after verified order facts change', async () => {
    const { row, order, read, headers } = await setup();
    await worker.recoverWorkflows(new Date(Date.now() + 500));
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    const waiting = await read();
    expect(waiting.state).toBe('WAITING_OWNER_APPROVAL');
    const response = await app.inject({ method: 'POST', url: '/api/v1/workflows/' + row.id + '/decision', headers,
      payload: { revision: waiting.revision, approve: true } });
    expect(response.statusCode, response.body).toBe(200);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await worker.recoverWorkflows(new Date());
    const ended = await read();
    expect(ended).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'APPROVAL_STALE', sendId: null,
      approval: { decision: 'APPROVED', executedAt: null } });
  });

  it('cannot execute an approval admitted under an older policy revision', async () => {
    const { row, read, headers } = await setup();
    await worker.recoverWorkflows(new Date(Date.now() + 500));
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    const waiting = await read();
    expect(waiting.state).toBe('WAITING_OWNER_APPROVAL');
    expect((await app.inject({ method: 'PUT', url: '/api/v1/workflow-settings', headers,
      payload: { profile: 'ONLINE_RETAIL', enabled: true, supportMode: 'VERIFIED_STATUS', revision: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/workflows/' + row.id + '/decision', headers,
      payload: { revision: waiting.revision, approve: true } })).statusCode).toBe(409);
    await worker.recoverWorkflows(new Date(Date.now() + 34_000));
    expect(await read()).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'BUSINESS_POLICY_CHANGED', sendId: null });
  });

  it('pauses eligible workflow work for an owner review without creating an outbound effect', async () => {
    const { row, read, headers } = await setup();
    const request = { method: 'POST' as const, url: '/api/v1/workflows/' + row.id + '/escalate', headers,
      payload: { revision: row.revision } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(409);
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    expect(await read()).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'ESCALATED_BY_OWNER', dueAt: null, sendId: null,
      evidence: expect.arrayContaining([expect.objectContaining({ eventKey: 'owner:escalated' })]) });
  });

  it('reconciles the original outbox record on retry and leaves an ambiguous attempt for review', async () => {
    const { row, read, headers } = await setup();
    await worker.recoverWorkflows(new Date(Date.now() + 500));
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    const waiting = await read();
    expect((await app.inject({ method: 'POST', url: '/api/v1/workflows/' + row.id + '/decision', headers,
      payload: { revision: waiting.revision, approve: true } })).statusCode).toBe(200);
    await worker.recoverWorkflows(new Date());
    const authorized = await read();
    await prisma.whatsAppSend.update({ where: { id: authorized.sendId! }, data: {
      state: 'REVIEW_REQUIRED', attempts: 1, nextAttemptAt: null, reason: 'PROVIDER_TRANSPORT_AMBIGUOUS',
    } });
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    const held = await read();
    expect(held).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'OUTBOUND_REQUIRES_REVIEW' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/workflows/' + row.id + '/retry', headers,
      payload: { revision: held.revision } })).statusCode).toBe(200);
    await worker.recoverWorkflows(new Date());
    expect(await read()).toMatchObject({ state: 'REVIEW_REQUIRED', sendId: authorized.sendId, recoveryCount: 1 });
    expect(await prisma.whatsAppSend.count({ where: { businessId: row.businessId } })).toBe(1);
    expect(await prisma.whatsAppSend.findUnique({ where: { id: authorized.sendId! } })).toMatchObject({ attempts: 1 });
  });

  it('fences an authorized outbound reply when the inbound phone changes owners', async () => {
    const { row, read, headers } = await setup();
    const phone = 'fixture-' + randomUUID();
    await prisma.business.update({ where: { id: row.businessId }, data: { waPhoneNumberId: phone } });
    const binding = await prisma.whatsAppPhoneOwnership.findFirstOrThrow({ where: {
      businessId: row.businessId, phoneNumberId: phone, endedAt: null,
    } });
    const source = await prisma.message.findUniqueOrThrow({ where: { id: row.sourceId } });
    await prisma.whatsAppTextReceipt.create({ data: { businessId: row.businessId, phoneNumberId: phone, waMessageId: source.waMessageId,
      ownershipId: binding.id, status: 'COMPLETED', sentAt: new Date(), messageId: source.id } });
    await worker.recoverWorkflows(new Date(Date.now() + 500));
    await worker.recoverWorkflows(new Date(Date.now() + 3_000));
    const waiting = await read();
    expect((await app.inject({ method: 'POST', url: '/api/v1/workflows/' + row.id + '/decision', headers,
      payload: { revision: waiting.revision, approve: true } })).statusCode).toBe(200);
    await worker.recoverWorkflows(new Date());
    const authorized = await read();
    expect(authorized).toMatchObject({ state: 'WAITING_PROVIDER', sendId: expect.any(String) });
    const send = await prisma.whatsAppSend.findUniqueOrThrow({ where: { id: authorized.sendId! } });
    const payload = send.payload as { body: string; workflowAuthorization: { id: string; evidenceKey: string; payment: boolean } };
    const { verifyWorkflowSend } = await import('../src/modules/workflows/workflow.support.js');
    const verify = () => prisma.$transaction((tx) => verifyWorkflowSend(tx, {
      ...payload, id: send.id, businessId: row.businessId, customerId: row.customerId, orderId: authorized.orderId!,
    }));
    expect(await verify()).toBe(true);
    await prisma.business.update({ where: { id: row.businessId }, data: { waPhoneNumberId: 'replacement-' + randomUUID() } });
    await prisma.business.create({ data: { name: 'Other synthetic shop', ownerName: 'Fixture', waPhoneNumberId: phone } });
    expect(await verify()).toBe(false);
    expect(await prisma.whatsAppSend.findUnique({ where: { id: send.id } })).toMatchObject({ attempts: 0, providerMessageId: null });
  });
});
