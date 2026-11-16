import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

const database = process.env.G1_BATCH_DATABASE_URL;
const cache = process.env.G1_BATCH_REDIS_URL;
const fixtureOnly = database || cache ? describe : describe.skip;

fixtureOnly('WhatsApp media capacity diagnostics on PostgreSQL', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let closeClients: () => void;
  const signingSecret = 'synthetic-media-capacity-fixture';
  beforeAll(async () => {
    if (![database, cache].every((url) => url && new URL(url).hostname === '127.0.0.1')) throw new Error('Use disposable IPv4 fixtures');
    const url = new URL(database!);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '4');
    process.env.DATABASE_URL = url.href;
    process.env.REDIS_URL = cache;
    process.env.META_WEBHOOK_SECRET = signingSecret;
    ({ prisma } = await import('../src/config/database.js'));
    await prisma.$connect();
    const connections = await import('../src/config/redis.js');
    closeClients = () => [connections.redis, connections.redisSubscriber, connections.sseSubscriber, connections.rateLimitRedis]
      .forEach((client) => client.disconnect());
    app = await (await import('../src/app.js')).createApp();
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); await prisma?.$disconnect(); }
    finally { closeClients?.(); }
  });

  it('retains a retryable outcome and redacted Prisma diagnostics during pool exhaustion and converges on exact replay', async () => {
    const phone = randomUUID();
    const foreignPhone = randomUUID();
    const business = await prisma.business.create({ data: { name: 'Fixture capacity', ownerName: 'Fixture', waPhoneNumberId: phone } });
    await prisma.business.create({ data: { name: 'Fixture isolated', ownerName: 'Fixture', waPhoneNumberId: foreignPhone } });
    const wamid = 'wamid.' + randomUUID();
    const from = '233209991221';
    function request(phoneNumber: string) {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: phoneNumber }, messages: [{ id: wamid, from, type: 'image',
          timestamp: String(Math.floor(Date.now() / 1000)), image: { id: 'private-media-fixture', mime_type: 'image/png' } }],
      } }] }] });
      return app.inject({ method: 'POST', url: '/api/v1/webhook', payload, headers: {
        'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', signingSecret).update(payload).digest('hex'),
      } });
    }
    const { logger } = await import('../src/config/logger.js');
    const log = vi.spyOn(logger, 'error');
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const transaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      acquired();
      await delay(5_000);
    }, { timeout: 7_000 });
    try {
      await held;
      const replies = await Promise.all([request(phone), request(phone), request(phone)]);
      expect(replies.map((response) => response.statusCode)).toEqual([503, 503, 503]);
      const entries = log.mock.calls.filter(([, message]) => message === 'Could not commit WhatsApp receipts');
      const diagnostics = JSON.stringify(entries);
      expect(entries, diagnostics).toHaveLength(3);
      for (const [fields] of entries) {
        const diagnostic = fields as { prismaCode?: string; failure?: string };
        expect(diagnostic, diagnostics).toMatchObject({ failure: 'DATABASE_POOL_ACQUISITION' });
        if (diagnostic.prismaCode) expect(['P2024', 'P2028']).toContain(diagnostic.prismaCode);
      }
      for (const privateField of [phone, from, wamid, 'private-media-fixture', signingSecret]) expect(diagnostics).not.toContain(privateField);
    } finally {
      await transaction;
      log.mockRestore();
    }
    expect(await prisma.whatsAppTextReceipt.count({ where: { waMessageId: wamid } })).toBe(0);
    for (const response of await Promise.all([request(phone), request(phone), request(phone)])) expect(response.statusCode).toBe(200);
    expect((await request(foreignPhone)).statusCode).toBe(200);
    const rows = await prisma.whatsAppTextReceipt.findMany({ where: { waMessageId: wamid } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.phoneNumberId === phone)).toMatchObject({ businessId: business.id, kind: 'MEDIA', status: 'PENDING' });
    expect(rows.find((row) => row.phoneNumberId === foreignPhone)).toMatchObject({ kind: 'MEDIA', status: 'FAILED',
      reason: 'MESSAGE_ID_COLLISION', sender: null, mediaId: null, messageId: null });
    expect(await prisma.message.count({ where: { waMessageId: wamid } })).toBe(0);
  }, 25_000);
});
