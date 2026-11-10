import { fork } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntentClassificationQueue,
  INTENT_CLASSIFICATION_QUEUE_NAME,
} from '../src/queues/intent.queue.js';

const databaseUrl = process.env.G1_TEST_DATABASE_URL;
const redisUrl = process.env.G1_TEST_REDIS_URL;
const webhookSecret = 'g1-local-fixture-webhook-signature-secret';

if (databaseUrl || redisUrl) {
  const database = new URL(databaseUrl ?? '');
  const redis = new URL(redisUrl ?? '');
  if (
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    !database.pathname.startsWith('/flowdesk_g1_') ||
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    !redis.port ||
    redis.port === '6379'
  ) {
    throw new Error(
      'G1 integration requires disposable loopback Postgres and a dedicated Redis port',
    );
  }
}

describe.skipIf(!databaseUrl || !redisUrl)(
  'durable WhatsApp text receipts with Postgres and BullMQ',
  () => {
    let prisma: PrismaClient;
    let app: FastifyInstance;
    let redis: Redis;
    let queue: ReturnType<typeof createIntentClassificationQueue>;
    let incoming: typeof import('../src/queues/message.queue.js').incomingMessagesQueue;
    let dispatch: typeof import('../src/workers/text-receipt.worker.js').dispatchTextReceipts;
    let producer: ReturnType<
      typeof import('../src/workers/text-receipt.worker.js').openTextReceiptQueue
    >;
    let disconnectRedis: () => Promise<void>;

    beforeAll(async () => {
      process.env.DATABASE_URL = databaseUrl!;
      process.env.REDIS_URL = redisUrl!;
      process.env.META_WEBHOOK_SECRET = webhookSecret;
      ({ prisma } = await import('../src/config/database.js'));
      await prisma.$connect();
      ({ disconnectRedis } = await import('../src/config/redis.js'));
      ({ incomingMessagesQueue: incoming } = await import('../src/queues/message.queue.js'));
      const { default: webhookRoutes } = await import('../src/modules/webhook/webhook.route.js');
      const worker = await import('../src/workers/text-receipt.worker.js');
      dispatch = worker.dispatchTextReceipts;
      producer = worker.openTextReceiptQueue();
      redis = new Redis(redisUrl!);
      queue = createIntentClassificationQueue({ connection: redis });
      await queue.waitUntilReady();
      app = Fastify();
      await app.register(import('fastify-raw-body'), {
        field: 'rawBody',
        global: false,
        encoding: false,
        runFirst: true,
      });
      await app.register(webhookRoutes, { prefix: '/api/v1' });
      await app.ready();
    }, 90_000);

    afterAll(async () => {
      await app?.close();
      await producer?.close();
      await queue?.close();
      await incoming?.close();
      await disconnectRedis?.();
      await redis?.quit();
      await prisma?.$disconnect();
    }, 30_000);

    const newId = () => `g1-${randomUUID()}`;
    const sender = '233201234567';
    const text = (id: string, body = 'Synthetic order enquiry') => ({
      id,
      from: sender,
      type: 'text',
      timestamp: String(Math.floor(Date.now() / 1000)),
      text: { body },
      context: { id: 'g1-prior-message' },
    });

    function change(phoneNumberId: string, ...messages: unknown[]) {
      return {
        field: 'messages',
        value: {
          metadata: { phone_number_id: phoneNumberId },
          contacts: [{ wa_id: sender, profile: { name: 'G1 Customer' } }],
          messages,
        },
      };
    }

    function signed(changes: unknown[], valid = true) {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes }] });
      const digest = createHmac('sha256', valid ? webhookSecret : 'invalid')
        .update(payload)
        .digest('hex');
      return app.inject({
        method: 'POST',
        url: '/api/v1/webhook',
        payload,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${digest}` },
      });
    }

    function tenant(waPhoneNumberId: string, active = true) {
      return prisma.business.create({
        data: { waPhoneNumberId, active, name: 'G1 Fixture', ownerName: 'Fixture' },
      });
    }

    function receipt(phoneNumberId: string, waMessageId: string) {
      return prisma.whatsAppTextReceipt.findUniqueOrThrow({
        where: { phoneNumberId_waMessageId: { phoneNumberId, waMessageId } },
      });
    }

    async function dueNow(id: string) {
      await prisma.whatsAppTextReceipt.update({
        where: { id },
        data: { nextAttemptAt: new Date() },
      });
    }

    async function crashDispatcher(phase: 'before-enqueue' | 'after-enqueue', waMessageId: string) {
      const child = fork(
        fileURLToPath(new URL('./fixtures/text-receipt-crash.ts', import.meta.url)),
        [phase, waMessageId],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        },
      );
      const exit = once(child, 'exit');
      try {
        const signal = await Promise.race([
          once(child, 'message', { signal: AbortSignal.timeout(60_000) }).then(
            ([message]) => message,
          ),
          exit.then(([code]) => {
            throw new Error(`Dispatcher exited before ${phase}, code ${code}`);
          }),
        ]);
        expect(signal).toBe(phase);
      } finally {
        child.kill('SIGKILL');
        await exit;
      }
    }

    it('rejects an invalid raw-body signature without a receipt or job', async () => {
      const phone = newId();
      const id = newId();
      expect((await signed([change(phone, text(id))], false)).statusCode).toBe(401);
      expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: id } })).toBe(0);
      expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
    });

    it('commits before 200 and links the correct customer and real classifier job', async () => {
      const phone = newId();
      const business = await tenant(phone);
      const id = newId();
      const reply = await signed([change(phone, text(id))]);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().data).toEqual({ processed: 1, acceptedText: 1, enqueued: 0, echoed: 0 });
      expect(await receipt(phone, id)).toMatchObject({
        status: 'PENDING',
        businessId: business.id,
        messageId: null,
      });
      expect(await queue.getJob(`intent-${id}`)).toBeUndefined();

      await dispatch(producer.enqueue);
      const done = await receipt(phone, id);
      expect(done).toMatchObject({
        status: 'COMPLETED',
        body: null,
        sender: null,
        nextAttemptAt: null,
      });
      const message = await prisma.message.findUniqueOrThrow({
        where: { id: done.messageId! },
        include: { customer: true },
      });
      expect(message).toMatchObject({
        businessId: business.id,
        waMessageId: id,
        body: 'Synthetic order enquiry',
        replyToWaId: 'g1-prior-message',
        customer: { businessId: business.id, waNumber: sender, name: 'G1 Customer' },
      });
      expect((await queue.getJob(`intent-${id}`))?.data).toEqual({
        businessId: business.id,
        messageId: message.id,
        waMessageId: id,
      });
    });

    it('returns 503 and rolls back the text batch on a real Postgres insert failure', async () => {
      const phone = newId();
      await tenant(phone);
      const id = newId();
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "whatsapp_text_receipts" ADD CONSTRAINT "g1_reject_fixture" CHECK ("body" IS DISTINCT FROM 'G1 forced failure') NOT VALID`,
      );
      try {
        const reply = await signed([change(phone, text(id), text(newId(), 'G1 forced failure'))]);
        expect(reply.statusCode).toBe(503);
        expect(reply.json().code).toBe('TEXT_RECEIPT_UNAVAILABLE');
        expect(await prisma.whatsAppTextReceipt.count({ where: { phoneNumberId: phone } })).toBe(0);
        expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "whatsapp_text_receipts" DROP CONSTRAINT "g1_reject_fixture"',
        );
      }
      expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      expect((await receipt(phone, id)).status).toBe('COMPLETED');
    });

    it('retains a durable receipt when Redis rejects queue writes and recovers without redelivery', async () => {
      const phone = newId();
      await tenant(phone);
      const id = newId();
      const [, originalLimit] = (await redis.config('GET', 'maxmemory')) as string[];
      await redis.config('SET', 'maxmemory', '1');
      try {
        expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
        await dispatch(producer.enqueue);
        expect(await receipt(phone, id)).toMatchObject({
          status: 'WAITING_QUEUE',
          reason: 'QUEUE_UNAVAILABLE',
          attempts: 1,
        });
        expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
      } finally {
        await redis.config('SET', 'maxmemory', originalLimit!);
      }
      const waiting = await receipt(phone, id);
      expect(waiting.messageId).not.toBeNull();
      await dispatch(producer.enqueue, waiting.nextAttemptAt!);
      expect(await receipt(phone, id)).toMatchObject({
        status: 'COMPLETED',
        messageId: waiting.messageId,
      });
      expect(await queue.getJob(`intent-${id}`)).toBeDefined();
    });

    for (const phase of ['before-enqueue', 'after-enqueue'] as const) {
      it(`recovers after the dispatcher process dies ${phase}`, async () => {
        const phone = newId();
        await tenant(phone);
        const id = newId();
        expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
        await crashDispatcher(phase, id);
        const pending = await receipt(phone, id);
        expect(pending.status).toBe('PENDING');
        expect(pending.messageId).not.toBeNull();
        expect(Boolean(await queue.getJob(`intent-${id}`))).toBe(phase === 'after-enqueue');

        await vi.waitFor(async () => {
          await dispatch(producer.enqueue);
          expect((await receipt(phone, id)).status).toBe('COMPLETED');
        }, { timeout: 15_000 });
        expect(await receipt(phone, id)).toMatchObject({
          status: 'COMPLETED',
          messageId: pending.messageId,
        });
        expect(await prisma.message.count({ where: { waMessageId: id } })).toBe(1);
        const matching = (await queue.getJobs(['waiting'])).filter(
          (job) => job.data.waMessageId === id,
        );
        expect(matching).toHaveLength(1);
      }, 100_000);
    }

    it('uses durable processed evidence after a crash and eviction, including provider replay', async () => {
      const phone = newId();
      await tenant(phone);
      const id = newId();
      expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
      await crashDispatcher('after-enqueue', id);

      // A real BullMQ worker consumes the job. Its fixture writes the same
      // durable processed marker as the classifier, without commercial effects.
      const worker = new Worker(
        INTENT_CLASSIFICATION_QUEUE_NAME,
        async (job) => {
          await prisma.message.update({
            where: { id: job.data.messageId },
            data: { processed: true, processedAt: new Date() },
          });
        },
        { connection: redisUrlOptions(), autorun: false },
      );
      try {
        const unexpectedExit = worker.run().then(() => {
          throw new Error('Classifier fixture stopped before consuming its job');
        });
        await Promise.race([
          unexpectedExit,
          vi.waitFor(async () => {
            expect(await (await queue.getJob(`intent-${id}`))?.getState()).toBe('completed');
          }, { timeout: 45_000 }),
        ]);
      } finally {
        await worker.close();
      }
      const job = await queue.getJob(`intent-${id}`);
      await job?.remove();
      expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      expect((await receipt(phone, id)).status).toBe('COMPLETED');
      expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
      expect(await prisma.message.count({ where: { waMessageId: id } })).toBe(1);
    }, 120_000);

    it('deduplicates concurrent HTTP deliveries and competing recovery passes', async () => {
      const phone = newId();
      await tenant(phone);
      const id = newId();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => signed([change(phone, text(id))])),
      );
      expect(responses.some((reply) => reply.statusCode === 200)).toBe(true);
      for (const reply of responses) {
        if (reply.statusCode === 200) continue;
        expect(reply.statusCode).toBe(503);
        expect(reply.json().code).toBe('TEXT_RECEIPT_UNAVAILABLE');
        expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
      }
      expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: id } })).toBe(1);
      await Promise.all(Array.from({ length: 5 }, () => dispatch(producer.enqueue)));
      const done = await receipt(phone, id);
      expect(done.status).toBe('COMPLETED');
      expect(await prisma.message.count({ where: { waMessageId: id } })).toBe(1);
      expect(
        (await queue.getJobs(['waiting'])).filter((job) => job.data.waMessageId === id),
      ).toHaveLength(1);
    });

    it('isolates malformed members and preserves valid media and app echoes in a mixed delivery', async () => {
      const phone = newId();
      const business = await tenant(phone);
      const id = newId();
      const audio = newId();
      const echo = newId();
      const reply = await signed([
        null,
        { field: 'messages', value: { messages: [text(newId())] } },
        change(phone, null, { ...text(newId()), text: {} }, text('x'.repeat(3_000)), text(id), {
          ...text(audio),
          type: 'audio',
          audio: { id: 'g1-audio', mime_type: 'audio/ogg' },
        }),
        {
          field: 'smb_message_echoes',
          value: {
            metadata: { phone_number_id: phone },
            message_echoes: [
              { ...text(newId()), text: undefined, to: sender },
              { ...text(echo, 'Owner echo'), to: sender },
            ],
          },
        },
      ]);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().data).toEqual({ processed: 2, acceptedText: 1, enqueued: 1, echoed: 1 });
      expect(await prisma.whatsAppTextReceipt.count({ where: { phoneNumberId: phone } })).toBe(1);
      expect((await incoming.getJob(`msg-${audio}`))?.data.message.type).toBe('AUDIO');
      expect(await prisma.message.findUnique({ where: { waMessageId: echo } })).toMatchObject({
        businessId: business.id,
        direction: 'OUTBOUND',
        sentFromApp: true,
      });
      await dispatch(producer.enqueue);
      expect((await receipt(phone, id)).status).toBe('COMPLETED');
    });

    it('quarantines a second tenant claiming the same provider ID without touching the first', async () => {
      const phoneA = newId();
      const phoneB = newId();
      const a = await tenant(phoneA);
      const b = await tenant(phoneB);
      const id = newId();
      expect((await signed([change(phoneA, text(id, 'original'))])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      const original = await receipt(phoneA, id);

      expect((await signed([change(phoneB, text(id, 'collision'))])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      expect(await receipt(phoneB, id)).toMatchObject({
        status: 'FAILED',
        reason: 'MESSAGE_ID_COLLISION',
        businessId: b.id,
        messageId: null,
      });
      expect(await prisma.customer.count({ where: { businessId: b.id } })).toBe(0);
      expect(await prisma.message.findUnique({ where: { waMessageId: id } })).toMatchObject({
        id: original.messageId,
        businessId: a.id,
        body: 'original',
      });
      expect((await queue.getJob(`intent-${id}`))?.data.businessId).toBe(a.id);
    });

    it('waits for an inactive pinned tenant, then resumes for that tenant only', async () => {
      const phone = newId();
      const business = await tenant(phone, false);
      const id = newId();
      expect((await signed([change(phone, text(id))])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      const waiting = await receipt(phone, id);
      expect(waiting).toMatchObject({
        businessId: business.id,
        status: 'WAITING_MAPPING',
        reason: 'PHONE_NOT_ACTIVE',
      });
      await prisma.business.update({ where: { id: business.id }, data: { active: true } });
      await dispatch(producer.enqueue, waiting.nextAttemptAt!);
      expect((await receipt(phone, id)).status).toBe('COMPLETED');
    });

    it('requires review for unbound phones and refuses a reassigned pinned phone', async () => {
      const unbound = newId();
      const id = newId();
      expect((await signed([change(unbound, text(id))])).statusCode).toBe(200);
      const waiting = await receipt(unbound, id);
      expect(waiting).toMatchObject({
        businessId: null,
        status: 'WAITING_MAPPING',
        reason: 'PHONE_OWNER_UNVERIFIED',
      });
      await tenant(unbound);
      await dueNow(waiting.id);
      await dispatch(producer.enqueue);
      expect(await receipt(unbound, id)).toMatchObject({
        status: 'FAILED',
        reason: 'PHONE_OWNER_UNVERIFIED',
      });

      const phone = newId();
      const original = await tenant(phone);
      const reassigned = newId();
      expect((await signed([change(phone, text(reassigned))])).statusCode).toBe(200);
      await prisma.business.update({ where: { id: original.id }, data: { waPhoneNumberId: null } });
      await tenant(phone);
      await dispatch(producer.enqueue);
      expect(await receipt(phone, reassigned)).toMatchObject({
        businessId: original.id,
        status: 'FAILED',
        reason: 'PHONE_OWNER_CHANGED',
        messageId: null,
      });
      expect(await queue.getJob(`intent-${reassigned}`)).toBeUndefined();
    });

    it('stops automatic retries at the attempt limit and preserves the receipt for recovery', async () => {
      const phone = newId();
      const business = await tenant(phone, false);
      const id = newId();
      await signed([change(phone, text(id))]);
      const pending = await receipt(phone, id);
      await prisma.whatsAppTextReceipt.update({
        where: { id: pending.id },
        data: { attempts: 11 },
      });
      await dispatch(producer.enqueue);
      expect(await receipt(phone, id)).toMatchObject({
        status: 'FAILED',
        attempts: 12,
        reason: 'PHONE_NOT_ACTIVE',
        nextAttemptAt: null,
        body: 'Synthetic order enquiry',
      });

      await prisma.business.update({ where: { id: business.id }, data: { active: true } });
      await prisma.whatsAppTextReceipt.updateMany({
        where: {
          id: pending.id,
          businessId: business.id,
          status: 'FAILED',
          reason: 'PHONE_NOT_ACTIVE',
        },
        data: {
          status: 'PENDING',
          reason: null,
          attempts: 0,
          finishedAt: null,
          nextAttemptAt: new Date(),
        },
      });
      await dispatch(producer.enqueue);
      expect(await receipt(phone, id)).toMatchObject({
        status: 'COMPLETED',
        businessId: business.id,
      });
    });

    it('quarantines a replay older than receipt retention with no retained text or tenant side effects', async () => {
      const phone = newId();
      const business = await tenant(phone);
      const id = newId();
      const stale = { ...text(id), timestamp: String(Math.floor(Date.now() / 1000) - 31 * 86_400) };
      expect((await signed([change(phone, stale)])).statusCode).toBe(200);
      await dispatch(producer.enqueue);
      expect(await receipt(phone, id)).toMatchObject({
        status: 'FAILED',
        reason: 'STALE_EVENT',
        body: null,
        sender: null,
        nextAttemptAt: null,
      });
      expect(await prisma.customer.count({ where: { businessId: business.id } })).toBe(0);
      expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
    });

    it('attaches a compatible legacy message without overwriting or classifying it again', async () => {
      const phone = newId();
      const business = await tenant(phone);
      const customer = await prisma.customer.create({
        data: { businessId: business.id, waNumber: sender },
      });
      const id = newId();
      const legacy = await prisma.message.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          waMessageId: id,
          direction: 'INBOUND',
          body: 'original legacy text',
          processed: true,
          processedAt: new Date(),
        },
      });
      await signed([change(phone, text(id, 'replay must not replace the body'))]);
      await dispatch(producer.enqueue);
      expect(await receipt(phone, id)).toMatchObject({ status: 'COMPLETED', messageId: legacy.id });
      expect(await prisma.message.findUnique({ where: { id: legacy.id } })).toMatchObject({
        customerId: customer.id,
        body: 'original legacy text',
        processed: true,
      });
      expect(await queue.getJob(`intent-${id}`)).toBeUndefined();
    });

    function redisUrlOptions() {
      const url = new URL(redisUrl!);
      return {
        host: url.hostname,
        port: Number(url.port),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
        db: Number(url.pathname.slice(1) || 0),
      };
    }
  },
);
