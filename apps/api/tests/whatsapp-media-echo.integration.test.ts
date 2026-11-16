import { fork } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntentClassificationQueue } from '../src/queues/intent.queue.js';
import { localWhatsAppTransport } from './fixtures/whatsapp-media-transport.js';

const databaseUrl = process.env.G1_06_TEST_DATABASE_URL;
const redisUrl = process.env.G1_06_TEST_REDIS_URL;
if (databaseUrl || redisUrl) {
  const db = new URL(databaseUrl ?? '');
  const redis = new URL(redisUrl ?? '');
  if (
    db.protocol !== 'postgresql:' ||
    db.hostname !== '127.0.0.1' ||
    !db.pathname.startsWith('/flowdesk_g1_') ||
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    !redis.port ||
    redis.port === '6379'
  ) {
    throw new Error('G1-06 requires disposable loopback fixtures');
  }
}

const secret = 'g106-local-fixture-webhook-signature-secret';
const customer = '233201234567';
const display = '233251234567';
const id = () => `g106-${randomUUID()}`;
const timestamp = () => String(Math.floor(Date.now() / 1_000));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH5sAAAAASUVORK5CYII=',
  'base64',
);
const ogg = Buffer.from('OggS\x00\x02\x01\x00OpusHead\x01fixture');
const pdf = Buffer.from('%PDF-1.4\n% synthetic test\n%%EOF\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');
type Sample = { bytes: Buffer; mime: string; mode?: 'hang' | 'size' | 'bad-url' | 'redirect' };

describe.skipIf(!databaseUrl || !redisUrl)(
  'durable WhatsApp media and echoes with real PostgreSQL and BullMQ',
  () => {
    let prisma: PrismaClient;
    let redis: Redis;
    let queue: ReturnType<typeof createIntentClassificationQueue>;
    let openQueue: typeof import('../src/workers/text-receipt.worker.js').openTextReceiptQueue;
    let producer: ReturnType<typeof openQueue>;
    let dispatch: typeof import('../src/workers/text-receipt.worker.js').dispatchTextReceipts;
    let disconnectRedis: () => Promise<void>;
    let app: FastifyInstance;
    let server: Server;
    let origin: string;
    let restoreFetch: () => void;
    const samples = new Map<string, Sample>();
    const tokens = new Map<string, string>();
    const objects = new Map<
      string,
      { bytes: Buffer; mime: string; metadata: Record<string, string> }
    >();
    const downloads = new Map<string, number>();
    let storageDown = false;
    let storageReads = 0;
    let pausePut = false;

    beforeAll(async () => {
      server = createServer(async (request, response) => {
        const url = new URL(request.url!, 'http://localhost');
        const mediaId = url.pathname.split('/').at(-1)!;
        const sample = samples.get(mediaId);
        if (url.pathname.startsWith('/graph/')) {
          const phone = url.searchParams.get('phone_number_id') ?? '';
          if (!sample || `Bearer ${tokens.get(phone)}` !== request.headers.authorization) {
            response.writeHead(403).end();
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              id: mediaId,
              mime_type: sample.mime,
              sha256: sha(sample.bytes),
              file_size: sample.mode === 'size' ? 150_000_000 : sample.bytes.length,
              url:
                sample.mode === 'bad-url'
                  ? `${origin}/secret`
                  : `https://lookaside.fbsbx.com/whatsapp_business/attachments/${mediaId}`,
            }),
          );
        } else if (url.pathname.startsWith('/whatsapp_business/attachments/')) {
          if (
            !sample ||
            ![...tokens.values()].some(
              (token) => `Bearer ${token}` === request.headers.authorization,
            )
          ) {
            response.writeHead(403).end();
            return;
          }
          downloads.set(mediaId, (downloads.get(mediaId) ?? 0) + 1);
          if (sample.mode === 'hang') return;
          if (sample.mode === 'redirect') {
            response.writeHead(302, { Location: `${origin}/secret` }).end();
            return;
          }
          response
            .writeHead(200, { 'Content-Type': sample.mime, 'Content-Length': sample.bytes.length })
            .end(sample.bytes);
        } else if (url.pathname.startsWith('/g106/')) {
          const key = decodeURIComponent(url.pathname.slice('/g106/'.length));
          if (request.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk);
            if (storageDown) {
              response.writeHead(503).end('<Error><Code>SlowDown</Code></Error>');
              return;
            }
            const metadata = Object.fromEntries(
              Object.entries(request.headers).filter(
                ([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string',
              ),
            ) as Record<string, string>;
            objects.set(key, {
              bytes: Buffer.concat(chunks),
              mime: request.headers['content-type']!,
              metadata,
            });
            if (pausePut) return;
            response.writeHead(200, { ETag: '"synthetic"' }).end();
          } else if (request.method === 'GET' || request.method === 'HEAD') {
            if (request.method === 'GET') storageReads++;
            const object = objects.get(key);
            if (!object) {
              response.writeHead(404).end();
              return;
            }
            response
              .writeHead(200, {
                'Content-Type': object.mime,
                'Content-Length': object.bytes.length,
                ...object.metadata,
              })
              .end(request.method === 'GET' ? object.bytes : undefined);
          } else response.writeHead(405).end();
        } else response.writeHead(418).end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      origin = `http://127.0.0.1:${address.port}`;
      restoreFetch = localWhatsAppTransport(origin);
      process.env.DATABASE_URL = databaseUrl!;
      process.env.REDIS_URL = redisUrl!;
      process.env.META_WEBHOOK_SECRET = secret;
      process.env.S3_ENDPOINT = origin;
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.AWS_ACCESS_KEY_ID = 'g106-synthetic-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'g106-synthetic-secret';
      process.env.AWS_S3_BUCKET = 'g106';
      ({ prisma } = await import('../src/config/database.js'));
      await prisma.$connect();
      ({ disconnectRedis } = await import('../src/config/redis.js'));
      const worker = await import('../src/workers/text-receipt.worker.js');
      openQueue = worker.openTextReceiptQueue;
      dispatch = worker.dispatchTextReceipts;
      producer = openQueue();
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
      await app.register((await import('../src/modules/webhook/webhook.route.js')).default);
      await app.register(async (api) => {
        api.addHook('preHandler', async (request) => {
          const businessId = request.headers['x-fixture-tenant'];
          if (typeof businessId === 'string') {
            request.business = { id: businessId } as typeof request.business;
            request.user = request.headers['x-fixture-rider']
              ? ({ staffId: 'synthetic-rider', role: 'DELIVERY' } as typeof request.user)
              : ({} as typeof request.user);
          }
        });
        await api.register((await import('../src/modules/messages/messages.route.js')).default);
      });
      await app.ready();
    }, 90_000);

    afterAll(async () => {
      restoreFetch?.();
      await app?.close();
      await producer?.close();
      await queue?.close();
      await disconnectRedis?.();
      await redis?.quit();
      await prisma?.$disconnect();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 30_000);

    async function tenant(phone = id(), active = true) {
      const token = id();
      tokens.set(phone, token);
      return prisma.business.create({
        data: {
          name: 'Synthetic G1-06',
          ownerName: 'Fixture',
          waPhoneNumberId: phone,
          waDisplayNumber: display,
          waAccessToken: token,
          active,
        },
      });
    }

    function envelope(phone: string, messages: unknown[], echo = false) {
      return {
        field: echo ? 'smb_message_echoes' : 'messages',
        value: {
          metadata: { phone_number_id: phone, display_phone_number: display },
          [echo ? 'message_echoes' : 'messages']: messages,
        },
      };
    }

    function signed(changes: unknown[], authentic = true) {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes }] });
      const digest = createHmac('sha256', authentic ? secret : 'incorrect-key')
        .update(payload)
        .digest('hex');
      return app.inject({
        method: 'POST',
        url: '/webhook',
        payload,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${digest}` },
      });
    }

    function media(type = 'image', bytes = png, mime = 'image/png') {
      const mediaId = id();
      samples.set(mediaId, { bytes, mime });
      return {
        mediaId,
        event: {
          id: id(),
          from: customer,
          timestamp: timestamp(),
          type,
          [type]: {
            id: mediaId,
            mime_type: mime,
            sha256: sha(bytes),
            ...(['image', 'document', 'video'].includes(type)
              ? { caption: 'Synthetic media caption' }
              : {}),
          },
        },
      };
    }

    const echo = (messageId = id()) => ({
      id: messageId,
      type: 'text',
      from: display,
      to: customer,
      timestamp: timestamp(),
      text: { body: 'Synthetic owner reply' },
    });
    const receipt = (phoneNumberId: string, waMessageId: string) =>
      prisma.whatsAppTextReceipt.findUniqueOrThrow({
        where: { phoneNumberId_waMessageId: { phoneNumberId, waMessageId } },
      });
    const message = (waMessageId: string) =>
      prisma.message.findUniqueOrThrow({
        where: { waMessageId },
        include: { customer: true },
      });
    const run = (businessId: string) => dispatch(producer.enqueue, new Date(), businessId);
    const due = (receiptId: string) =>
      prisma.whatsAppTextReceipt.update({
        where: { id: receiptId },
        data: { nextAttemptAt: new Date() },
      });

    async function withReceiptWriteFailure<T>(runTest: () => Promise<T>): Promise<T> {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION g106_reject_insert() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'synthetic storage failure'; END; $$`);
      try {
        await prisma.$executeRawUnsafe(
          'CREATE TRIGGER g106_reject_insert BEFORE INSERT ON whatsapp_text_receipts FOR EACH ROW EXECUTE FUNCTION g106_reject_insert()',
        );
        return await runTest();
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS g106_reject_insert ON whatsapp_text_receipts',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION g106_reject_insert()');
      }
    }

    it.each([
      ['image', png, 'image/png'],
      ['audio', ogg, 'audio/ogg'],
      ['document', pdf, 'application/pdf'],
      ['document', Buffer.from('synthetic document'), 'text/plain'],
      ['video', Buffer.from('0000ftypisom-fixture'), 'video/mp4'],
      ['sticker', Buffer.from('RIFF0000WEBPVP8 fixture'), 'image/webp'],
    ])('commits, archives and hands off signed %s content (%s, %s)', async (type, bytes, mime) => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const { event } = media(type, bytes, mime);
      expect((await signed([envelope(phone, [event])])).json().data.acceptedMedia).toBe(1);
      expect(await receipt(phone, event.id)).toMatchObject({
        businessId: business.id,
        status: 'PENDING',
        messageId: null,
      });
      expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
      await run(business.id);
      const row = await message(event.id);
      expect(row).toMatchObject({
        businessId: business.id,
        direction: 'INBOUND',
        mediaType: mime,
        mediaPhoneNumberId: phone,
        createdAt: new Date(Number(event.timestamp) * 1_000),
        customer: { businessId: business.id, waNumber: customer },
      });
      expect(objects.get(row.mediaKey!)).toMatchObject({ bytes, mime });
      expect(await receipt(phone, event.id)).toMatchObject({
        status: 'COMPLETED',
        mediaId: null,
        sender: null,
        messageId: row.id,
      });
      const job = await queue.getJob(`intent-${event.id}`);
      if (type === 'audio' || type === 'sticker') {
        expect(job).toBeUndefined();
        expect(row).toMatchObject({
          intent: 'UNCLASSIFIED',
          processingError: 'MEDIA_ANALYSIS_UNSUPPORTED',
          requiresReview: true,
        });
      } else {
        expect(job?.data).toMatchObject({ messageId: row.id, businessId: business.id });
      }
    });

    it('rejects unauthenticated bytes and a structurally invalid signed envelope', async () => {
      const business = await tenant();
      const { event, mediaId } = media();
      expect((await signed([envelope(business.waPhoneNumberId!, [event])], false)).statusCode).toBe(
        401,
      );
      expect((await signed([null, { field: null, value: [] }])).statusCode).toBe(400);
      expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: event.id } })).toBe(0);
      expect(await prisma.message.count({ where: { waMessageId: event.id } })).toBe(0);
      expect(downloads.has(mediaId)).toBe(false);
    });

    it.each(['MEDIA_UNSUPPORTED', 'MEDIA_INVALID', 'MEDIA_TOO_LARGE', 'HOST', 'REDIRECT'])(
      'quarantines an invalid transfer (%s) without storage or classification',
      async (failure) => {
        const business = await tenant();
        const phone = business.waPhoneNumberId!;
        const { event, mediaId } =
          failure === 'MEDIA_UNSUPPORTED'
            ? media('image', png, 'image/svg+xml')
            : failure === 'MEDIA_INVALID'
              ? media('image', Buffer.from('not an image'))
              : media();
        if (failure === 'MEDIA_TOO_LARGE') samples.get(mediaId)!.mode = 'size';
        if (failure === 'HOST') samples.get(mediaId)!.mode = 'bad-url';
        if (failure === 'REDIRECT') samples.get(mediaId)!.mode = 'redirect';
        expect((await signed([envelope(phone, [event])])).statusCode).toBe(200);
        await run(business.id);
        const reason = failure === 'HOST' || failure === 'REDIRECT' ? 'MEDIA_INVALID' : failure;
        expect(await receipt(phone, event.id)).toMatchObject({ status: 'FAILED', reason });
        const row = await message(event.id);
        expect(row).toMatchObject({
          mediaUrl: null,
          processed: false,
          requiresReview: true,
          processingError: reason,
        });
        expect(objects.has(row.mediaKey!)).toBe(false);
        expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
      },
    );

    it('deduplicates simultaneous receipt writes, archive claims, jobs and post-completion replay', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const { event, mediaId } = media();
      const deliver = () => signed([envelope(phone, [event])]);
      expect(
        (await Promise.all(Array.from({ length: 8 }, deliver))).map(
          (response) => response.statusCode,
        ),
      ).toEqual(Array(8).fill(200));
      await Promise.all(Array.from({ length: 6 }, () => run(business.id)));
      expect((await deliver()).statusCode).toBe(200);
      await run(business.id);
      expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: event.id } })).toBe(1);
      expect(await prisma.message.count({ where: { waMessageId: event.id } })).toBe(1);
      expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
      expect(downloads.get(mediaId)).toBe(1);
      expect(
        (await queue.getJobs(['waiting'])).filter((job) => job.data.waMessageId === event.id),
      ).toHaveLength(1);
    });

    it.each([false, true])(
      'returns retryable 503 when the database rejects a media or echo receipt (echo %s)',
      async (isEcho) => {
        const business = await tenant();
        const phone = business.waPhoneNumberId!;
        const event = isEcho ? echo() : media().event;
        const deliver = () => signed([envelope(phone, [event], isEcho)]);
        const response = await withReceiptWriteFailure(deliver);
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('WHATSAPP_RECEIPT_UNAVAILABLE');
        expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: event.id } })).toBe(
          0,
        );
        expect(await prisma.message.count({ where: { waMessageId: event.id } })).toBe(0);
        expect((await deliver()).statusCode).toBe(200);
        await run(business.id);
        expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
      },
    );

    it('recovers from Redis rejecting the archive handoff without downloading again', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const { event, mediaId } = media();
      expect((await signed([envelope(phone, [event])])).statusCode).toBe(200);
      const [, originalLimit] = (await redis.config('GET', 'maxmemory')) as [string, string];
      await redis.config('SET', 'maxmemory', '1');
      try {
        await run(business.id);
      } finally {
        await redis.config('SET', 'maxmemory', originalLimit);
      }
      const waiting = await receipt(phone, event.id);
      expect(waiting).toMatchObject({
        status: 'WAITING_QUEUE',
        reason: 'QUEUE_UNAVAILABLE',
        mediaArchivedAt: expect.any(Date),
      });
      expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
      await due(waiting.id);
      await run(business.id);
      expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
      expect(downloads.get(mediaId)).toBe(1);
      expect(await queue.getJob(`intent-${event.id}`)).toBeDefined();
    });

    it.each(['timeout', 'object write'])(
      'waits durably and recovers after a %s failure',
      async (fault) => {
        const business = await tenant();
        const phone = business.waPhoneNumberId!;
        const { event, mediaId } = media();
        const sample = samples.get(mediaId)!;
        if (fault === 'timeout') sample.mode = 'hang';
        else storageDown = true;
        try {
          expect((await signed([envelope(phone, [event])])).statusCode).toBe(200);
          await run(business.id);
        } finally {
          delete sample.mode;
          storageDown = false;
        }
        const waiting = await receipt(phone, event.id);
        expect(waiting).toMatchObject({
          status: 'WAITING_MEDIA',
          reason: fault === 'timeout' ? 'MEDIA_TIMEOUT' : 'MEDIA_STORAGE_UNAVAILABLE',
          attempts: 1,
          mediaClaims: 1,
        });
        expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
        expect(await message(event.id)).toMatchObject({ requiresReview: true, mediaUrl: null });
        expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
        await due(waiting.id);
        await run(business.id);
        expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
        expect((await message(event.id)).processingError).toBeNull();
        expect(downloads.get(mediaId)).toBe(2);
      },
      30_000,
    );

    it.each([
      'before-message',
      'after-message',
      'download',
      'object-written',
      'before-queue',
      'after-queue',
    ])(
      'restarts after killing the worker at %s',
      async (phase) => {
        const business = await tenant();
        const phone = business.waPhoneNumberId!;
        const { event, mediaId } = media();
        const changes = [envelope(phone, [event])];
        expect((await signed(changes)).statusCode).toBe(200);
        const accepted = await receipt(phone, event.id);
        if (phase === 'download') samples.get(mediaId)!.mode = 'hang';
        const objectCount = objects.size;
        if (phase === 'object-written') pausePut = true;
        const child = fork(
          fileURLToPath(new URL('./fixtures/whatsapp-media-crash.ts', import.meta.url)),
          [phase, accepted.id, business.id, origin],
          { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        );
        const exited = once(child, 'exit');
        try {
          const reached =
            phase === 'download'
              ? (async () => {
                  await expect.poll(() => downloads.get(mediaId), { timeout: 35_000 }).toBe(1);
                })()
              : phase === 'object-written'
                ? (async () => {
                    await expect
                      .poll(() => objects.size, { timeout: 35_000 })
                      .toBe(objectCount + 1);
                  })()
                : once(child, 'message', { signal: AbortSignal.timeout(35_000) }).then(([value]) =>
                    expect(value).toBe(phase),
                  );
          await Promise.race([
            reached,
            exited.then(([code]) => {
              throw new Error(`Child exited early: ${code}`);
            }),
          ]);
        } finally {
          child.kill('SIGKILL');
          await exited;
          delete samples.get(mediaId)!.mode;
          pausePut = false;
        }
        const interrupted = await receipt(phone, event.id);
        expect(Boolean(interrupted.messageId)).toBe(phase !== 'before-message');
        expect(Boolean(interrupted.mediaArchivedAt)).toBe(phase.endsWith('queue'));
        expect(Boolean(await queue.getJob(`intent-${event.id}`))).toBe(phase === 'after-queue');
        if (phase === 'download' || phase === 'object-written') {
          expect(interrupted.leaseUntil).toBeInstanceOf(Date);
          expect(await run(business.id)).toBe(0);
          await prisma.whatsAppTextReceipt.update({
            where: { id: interrupted.id },
            data: { leaseUntil: new Date(0) },
          });
        }
        if (phase === 'object-written') samples.delete(mediaId);
        expect((await signed(changes)).statusCode).toBe(200);
        // A killed client can exit before PostgreSQL has rolled back its transaction.
        // Wait for the locks on this receipt to be released before running SKIP LOCKED recovery.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          await tx.$queryRaw`SELECT id FROM whatsapp_text_receipts WHERE id = ${interrupted.id} FOR UPDATE`;
        }, { timeout: 7_500 });
        await run(business.id);
        expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
        expect(await prisma.message.count({ where: { waMessageId: event.id } })).toBe(1);
        expect(
          (await queue.getJobs(['waiting'])).filter((job) => job.data.waMessageId === event.id),
        ).toHaveLength(1);
        expect(downloads.get(mediaId)).toBe(phase === 'download' ? 2 : 1);
      },
      60_000,
    );

    it('records and deduplicates business echoes without classifying or opening the support window', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const first = echo();
      const deliver = (body: unknown) => signed([envelope(phone, [body], true)]);
      expect((await deliver(first)).json().data.acceptedEchoes).toBe(1);
      expect(await receipt(phone, first.id)).toMatchObject({
        kind: 'ECHO',
        status: 'PENDING',
        messageId: null,
      });
      expect(await prisma.message.count({ where: { waMessageId: first.id } })).toBe(0);
      await run(business.id);
      expect(
        (await deliver({ ...first, text: { body: 'should never overwrite' } })).statusCode,
      ).toBe(200);
      await run(business.id);
      expect(await message(first.id)).toMatchObject({
        body: first.text.body,
        direction: 'OUTBOUND',
        businessId: business.id,
        sentFromApp: true,
        processed: true,
        customer: { businessId: business.id, waNumber: customer, lastInboundAt: null },
      });
      expect(await queue.getJob(`intent-${first.id}`)).toBeUndefined();
      expect(await prisma.message.count({ where: { waMessageId: first.id } })).toBe(1);
      const falseEcho = { ...echo(), from: customer };
      expect((await deliver(falseEcho)).json().data.acceptedEchoes).toBeUndefined();
      const incoming = { ...echo(), from: customer };
      await signed([envelope(phone, [incoming])]);
      await run(business.id);
      expect((await message(incoming.id)).direction).toBe('INBOUND');
    });

    it('keeps mixed valid siblings, isolates malformed members and ignores delivery statuses', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const incoming = { ...echo(), from: customer };
      const outbound = echo();
      const image = media().event;
      const status = id();
      const response = await signed([
        null,
        envelope(phone, [false, { ...media().event, image: null }, incoming, image]),
        envelope(phone, [null, { ...echo(), text: null }, outbound], true),
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phone },
            statuses: [{ id: status, status: 'delivered' }],
          },
        },
      ]);
      expect(response.json().data).toMatchObject({
        acceptedText: 1,
        acceptedMedia: 1,
        acceptedEchoes: 1,
      });
      await run(business.id);
      expect(
        await prisma.whatsAppTextReceipt.count({
          where: { phoneNumberId: phone, status: 'COMPLETED' },
        }),
      ).toBe(3);
      expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: status } })).toBe(0);
      expect(await queue.getJob(`intent-${outbound.id}`)).toBeUndefined();
    });

    it('waits for inactive and unresolved mappings, and never binds unknown history to a new tenant', async () => {
      const unknown = id();
      const first = echo();
      expect((await signed([envelope(unknown, [first], true)])).statusCode).toBe(200);
      const unbound = await receipt(unknown, first.id);
      expect(unbound).toMatchObject({
        businessId: null,
        status: 'WAITING_MAPPING',
        reason: 'PHONE_OWNER_UNVERIFIED',
      });
      const later = await tenant(unknown);
      await due(unbound.id);
      await dispatch(producer.enqueue);
      expect(await receipt(unknown, first.id)).toMatchObject({
        businessId: null,
        status: 'FAILED',
      });
      await signed([envelope(unknown, [first], true)]);
      expect(
        await prisma.message.count({ where: { waMessageId: first.id, businessId: later.id } }),
      ).toBe(0);

      const inactive = await tenant(id(), false);
      const phone = inactive.waPhoneNumberId!;
      const second = echo();
      await signed([envelope(phone, [second], true)]);
      await run(inactive.id);
      const pending = await receipt(phone, second.id);
      expect(pending).toMatchObject({
        businessId: inactive.id,
        status: 'WAITING_MAPPING',
        reason: 'PHONE_NOT_ACTIVE',
      });
      await prisma.business.update({ where: { id: inactive.id }, data: { active: true } });
      await due(pending.id);
      await run(inactive.id);
      expect((await receipt(phone, second.id)).status).toBe('COMPLETED');
    });

    it('pins historical ownership even if the same tenant later reconnects a reassigned phone', async () => {
      const old = await tenant();
      const phone = old.waPhoneNumberId!;
      const historical = String(Number(timestamp()) - 120);
      await prisma.whatsAppPhoneOwnership.updateMany({
        where: { phoneNumberId: phone },
        data: { startedAt: new Date(Date.now() - 180_000) },
      });
      const pending = { ...echo(), timestamp: historical };
      await signed([envelope(phone, [pending], true)]);
      expect(await receipt(phone, pending.id)).toMatchObject({
        businessId: old.id,
        status: 'PENDING',
        ownershipId: expect.any(BigInt),
      });
      await prisma.business.update({ where: { id: old.id }, data: { waPhoneNumberId: null } });
      const replacement = await tenant(phone);
      const late = { ...echo(), timestamp: historical };
      await signed([envelope(phone, [late], true)]);
      expect(await receipt(phone, late.id)).toMatchObject({
        businessId: old.id,
        status: 'FAILED',
        reason: 'PHONE_OWNER_CHANGED',
      });
      await prisma.business.update({
        where: { id: replacement.id },
        data: { waPhoneNumberId: null },
      });
      await prisma.business.update({ where: { id: old.id }, data: { waPhoneNumberId: phone } });
      await signed([envelope(phone, [pending], true)]);
      await run(old.id);
      expect(await receipt(phone, pending.id)).toMatchObject({
        businessId: old.id,
        status: 'FAILED',
        reason: 'PHONE_OWNER_CHANGED',
      });
      expect(
        await prisma.message.count({ where: { waMessageId: { in: [late.id, pending.id] } } }),
      ).toBe(0);
    });

    it('quarantines a provider ID claimed first by another phone even when the second tenant dispatches first', async () => {
      const first = await tenant();
      const second = await tenant();
      const original = media().event;
      const collided = { ...echo(original.id), text: { body: 'collision' } };
      await signed([envelope(first.waPhoneNumberId!, [original])]);
      await signed([envelope(second.waPhoneNumberId!, [collided], true)]);
      await run(second.id);
      expect(await receipt(second.waPhoneNumberId!, collided.id)).toMatchObject({
        status: 'FAILED',
        reason: 'MESSAGE_ID_COLLISION',
        sender: null,
        body: null,
      });
      expect(await prisma.message.count({ where: { waMessageId: original.id } })).toBe(0);
      await run(first.id);
      expect(await message(original.id)).toMatchObject({
        direction: 'INBOUND',
        businessId: first.id,
        body: 'Synthetic media caption',
      });
    });

    it('reads only authorized media objects through the message route and rejects a forged storage key', async () => {
      const first = await tenant();
      const second = await tenant();
      const a = media().event;
      const b = media().event;
      await signed([envelope(first.waPhoneNumberId!, [a]), envelope(second.waPhoneNumberId!, [b])]);
      await run(first.id);
      await run(second.id);
      const one = await message(a.id);
      const two = await message(b.id);
      const fetchMedia = (businessId?: string, rider = false) =>
        app.inject({
          method: 'GET',
          url: `/messages/${one.id}/media`,
          headers: {
            ...(businessId ? { 'x-fixture-tenant': businessId } : {}),
            ...(rider ? { 'x-fixture-rider': '1' } : {}),
          },
        });
      const reads = storageReads;
      expect((await fetchMedia()).statusCode).toBe(401);
      expect((await fetchMedia(first.id, true)).statusCode).toBe(403);
      expect((await fetchMedia(second.id)).statusCode).toBe(404);
      expect(storageReads).toBe(reads);
      const result = await fetchMedia(first.id);
      expect(result.statusCode).toBe(200);
      expect(result.rawPayload).toEqual(png);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(one.mediaKey).toMatch(new RegExp(`^businesses/${first.id}/media/whatsapp-`));
      await prisma.message.update({ where: { id: one.id }, data: { mediaKey: two.mediaKey } });
      expect((await fetchMedia(first.id)).statusCode).toBe(404);
      expect(storageReads).toBe(reads + 1);
    });

    it('keeps provider event order, quarantines stale events and does not treat an echo as inbound activity', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      await prisma.whatsAppPhoneOwnership.updateMany({
        where: { phoneNumberId: phone },
        data: { startedAt: new Date(Date.now() - 180_000) },
      });
      const recent = media().event;
      const oldest = { ...media().event, timestamp: String(Number(recent.timestamp) - 60) };
      const outbound = { ...echo(), timestamp: String(Number(recent.timestamp) + 1) };
      const stale = { ...media().event, timestamp: String(Number(recent.timestamp) - 31 * 86_400) };
      const future = { ...media().event, timestamp: String(Number(recent.timestamp) + 86_400) };
      await signed([envelope(phone, [recent, stale, future]), envelope(phone, [outbound], true)]);
      await run(business.id);
      await signed([envelope(phone, [oldest])]);
      await run(business.id);
      const row = await message(oldest.id);
      expect(row.createdAt).toEqual(new Date(Number(oldest.timestamp) * 1_000));
      expect(row.customer).toMatchObject({
        lastInboundAt: new Date(Number(recent.timestamp) * 1_000),
        lastInteractionAt: new Date(Number(outbound.timestamp) * 1_000),
      });
      expect(await receipt(phone, stale.id)).toMatchObject({
        status: 'FAILED',
        reason: 'STALE_EVENT',
        mediaId: null,
      });
      expect(await receipt(phone, future.id)).toMatchObject({
        status: 'FAILED',
        reason: 'FUTURE_EVENT',
        mediaId: null,
      });
      expect(
        await prisma.message.count({ where: { waMessageId: { in: [stale.id, future.id] } } }),
      ).toBe(0);
    });

    it('keeps a receipt durable if echo materialization fails after admission', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const event = echo();
      expect((await signed([envelope(phone, [event], true)])).statusCode).toBe(200);
      await prisma.$executeRawUnsafe(`CREATE FUNCTION g106_reject_message() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'synthetic message write failure'; END; $$`);
      try {
        await prisma.$executeRawUnsafe(
          'CREATE TRIGGER g106_reject_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION g106_reject_message()',
        );
        await run(business.id);
        expect(await prisma.customer.count({ where: { businessId: business.id } })).toBe(0);
        expect(await prisma.message.count({ where: { waMessageId: event.id } })).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS g106_reject_message ON messages');
        await prisma.$executeRawUnsafe('DROP FUNCTION g106_reject_message()');
      }
      const waiting = await receipt(phone, event.id);
      expect(waiting).toMatchObject({ status: 'PENDING', reason: 'STORAGE_ERROR', attempts: 1 });
      await due(waiting.id);
      await run(business.id);
      expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
      expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
    });

    it('preserves the existing MoMo image review handoff without crediting a payment', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const { event } = media();
      const image = {
        ...event.image,
        caption: 'I sent the payment by mobile money. Here is the screenshot.',
      };
      await signed([envelope(phone, [{ ...event, image }])]);
      await run(business.id);
      const row = await message(event.id);
      const claim = await prisma.payment.findFirst({
        where: { businessId: business.id, screenshotKey: row.mediaKey },
      });
      expect(claim).toMatchObject({
        confidence: 'CLAIMED',
        customerId: row.customerId,
        screenshotUrl: row.mediaUrl,
        orderId: null,
      });
      expect(claim?.amount.isZero()).toBe(true);
      expect(row.requiresReview).toBe(true);
    });

    it('hands bodyless audio to review without an automated classification', async () => {
      const business = await tenant();
      const phone = business.waPhoneNumberId!;
      const { event } = media('audio', ogg, 'audio/ogg');
      await signed([envelope(phone, [event])]);
      await run(business.id);
      expect(await queue.getJob(`intent-${event.id}`)).toBeUndefined();
      expect((await receipt(phone, event.id)).status).toBe('COMPLETED');
      expect(await message(event.id)).toMatchObject({
        intent: 'UNCLASSIFIED',
        classifiedBy: null,
        processingError: 'MEDIA_ANALYSIS_UNSUPPORTED',
        requiresReview: true,
      });
    });

    it('preserves a pre-G1-06 pending text and historical outbound message during upgrade', async () => {
      const upgradeUrl = process.env.G1_06_UPGRADE_DATABASE_URL;
      if (!upgradeUrl) throw new Error('G1-06 requires a disposable upgrade database');
      const expected = new URL(databaseUrl!);
      const upgrade = new URL(upgradeUrl);
      if (
        upgrade.origin !== expected.origin ||
        upgrade.host !== expected.host ||
        upgrade.pathname !== '/flowdesk_g1_upgrade'
      )
        throw new Error('Unexpected upgrade target');
      const upgradeDb = new PrismaClient({ datasources: { db: { url: upgradeUrl } } });
      try {
        const pending = await upgradeDb.whatsAppTextReceipt.findUniqueOrThrow({
          where: { id: 'g106-upgrade-pending' },
        });
        const binding = await upgradeDb.whatsAppPhoneOwnership.findFirstOrThrow({
          where: { phoneNumberId: pending.phoneNumberId },
        });
        expect(pending).toMatchObject({
          kind: 'TEXT',
          messageType: 'TEXT',
          status: 'PENDING',
          ownershipId: binding.id,
        });
        expect(binding.businessId).toBe(pending.businessId);
        const historical = await upgradeDb.message.findUniqueOrThrow({
          where: { id: 'g106-upgrade-echo' },
        });
        expect(historical).toMatchObject({
          body: 'Synthetic historical outbound row',
          mediaPhoneNumberId: null,
        });
      } finally {
        await upgradeDb.$disconnect();
      }
    });
  },
);
