import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawBodyPluginOptions } from 'fastify-raw-body';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { success } from '../../utils/response.js';
import { incomingMessagesQueue } from '../../queues/message.queue.js';
import {
  handleVerification,
  parseWebhookPayload,
  validateWebhookSignature,
} from './webhook.service.js';

interface WebhookGetQuery {
  'hub.mode': string;
  'hub.verify_token': string;
  'hub.challenge': string;
}

interface WebhookPostRequest extends FastifyRequest {
  rawBody?: Buffer | string;
}

export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(import('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  } as RawBodyPluginOptions);

  app.get<{ Querystring: WebhookGetQuery }>('/webhook', async (request, reply) => {
    const challenge = handleVerification({
      mode: request.query['hub.mode'],
      token: request.query['hub.verify_token'],
      challenge: request.query['hub.challenge'],
    });

    if (challenge === null) {
      return reply.status(403).send({ success: false, error: 'Verification failed', code: 'VERIFICATION_FAILED' });
    }

    return reply.status(200).send(challenge);
  });

  app.post('/webhook', async (request: WebhookPostRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody;

    if (!rawBody) {
      return reply.status(400).send({ success: false, error: 'Missing raw body', code: 'MISSING_RAW_BODY' });
    }

    const signature = request.headers['x-hub-signature-256'];

    if (typeof signature !== 'string') {
      return reply.status(401).send({ success: false, error: 'Missing signature header', code: 'MISSING_SIGNATURE' });
    }

    const rawBodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const isValid = validateWebhookSignature(rawBodyBuffer, signature);

    if (!isValid) {
      logger.warn({ ip: request.ip, headers: request.headers }, 'Webhook signature verification failed');
      return reply.status(401).send({ success: false, error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
    }

    let parsedPayload;

    try {
      parsedPayload = JSON.parse(rawBodyBuffer.toString());
    } catch {
      return reply.status(400).send({ success: false, error: 'Invalid JSON payload', code: 'INVALID_JSON' });
    }

    const messages = parseWebhookPayload(parsedPayload);
    const enqueued: string[] = [];

    for (const msg of messages) {
      const business = await prisma.business.findFirst({
        where: {
          waPhoneNumberId: msg.businessPhoneNumberId,
          active: true,
          deletedAt: null,
        },
      });

      if (!business) {
        logger.warn({ phoneNumberId: msg.businessPhoneNumberId }, 'Webhook received for unknown business');
        continue;
      }

      const existing = await prisma.message.findUnique({
        where: {
          waMessageId: msg.waMessageId,
        },
      });

      if (existing) {
        continue;
      }

      const messageData: Prisma.MessageUncheckedCreateInput = {
        businessId: business.id,
        waMessageId: msg.waMessageId,
        direction: 'INBOUND',
        type: msg.type,
        rawPayload: (msg.rawPayload as unknown) as Prisma.InputJsonValue,
        processed: false,
      };
      if (msg.body !== undefined) messageData.body = msg.body;
      await prisma.message.create({ data: messageData });

      await incomingMessagesQueue.add(
        // @ts-expect-error BullMQ v5 type inference issue
        'process-incoming-message',
        {
          businessId: business.id,
          waMessageId: msg.waMessageId,
          message: msg,
          receivedAt: new Date().toISOString(),
        },
        {
          jobId: `msg:${msg.waMessageId}`,
        },
      );

      enqueued.push(msg.waMessageId);
    }

    return success(reply, {
      processed: messages.length,
      enqueued: enqueued.length,
    });
  });
}
