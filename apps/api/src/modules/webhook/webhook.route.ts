import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { incomingMessagesQueue } from '../../queues/message.queue.js';
import { maskPhone } from '../../utils/phone.js';
import { recordAppEcho } from './echo.service.js';
import {
  describeUnhandledFields,
  handleVerification,
  parseEchoPayload,
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

/**
 * Meta retries any webhook it does not see acknowledged quickly, so the handler
 * does the minimum: verify the signature, deduplicate, enqueue, return 200.
 * All persistence and business resolution happens in the worker.
 */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const DEDUPE_KEY_PREFIX = 'flowdesk:webhook:seen:';

/**
 * Claims a message id for processing. Returns false when this id has already
 * been seen, which happens routinely — Meta re-delivers on any timeout.
 */
async function claimMessage(waMessageId: string): Promise<boolean> {
  try {
    const result = await redis.set(
      `${DEDUPE_KEY_PREFIX}${waMessageId}`,
      '1',
      'EX',
      DEDUPE_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  } catch (error: unknown) {
    // Redis down: process the message rather than drop it. The queue's job id
    // and the unique index on waMessageId both still guard against duplicates.
    logger.warn({ error, waMessageId }, 'Webhook dedupe unavailable — allowing message through');
    return true;
  }
}

export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // `fastify-raw-body` is registered once on the /api/v1 context in app.ts so
  // the Paystack webhook gets it too; this route opts in per-route below.

  app.get<{ Querystring: WebhookGetQuery }>('/webhook', async (request, reply) => {
    const challenge = handleVerification({
      mode: request.query['hub.mode'],
      token: request.query['hub.verify_token'],
      challenge: request.query['hub.challenge'],
    });

    if (challenge === null) {
      return reply
        .status(403)
        .send({ success: false, error: 'Verification failed', code: 'VERIFICATION_FAILED' });
    }

    return reply.status(200).send(challenge);
  });

  app.post(
    '/webhook',
    { config: { rawBody: true } },
    async (request: WebhookPostRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody;

    if (!rawBody) {
      return reply
        .status(400)
        .send({ success: false, error: 'Missing raw body', code: 'MISSING_RAW_BODY' });
    }

    const signature = request.headers['x-hub-signature-256'];

    if (typeof signature !== 'string') {
      return reply
        .status(401)
        .send({ success: false, error: 'Missing signature header', code: 'MISSING_SIGNATURE' });
    }

    const rawBodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

    if (!validateWebhookSignature(rawBodyBuffer, signature)) {
      // Header contents are deliberately not logged — they carry the signature
      // and would leak into log aggregation.
      logger.warn({ ip: request.ip }, 'Webhook signature verification failed');
      return reply
        .status(401)
        .send({ success: false, error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawBodyBuffer.toString());
    } catch {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid JSON payload', code: 'INVALID_JSON' });
    }

    let messages: ReturnType<typeof parseWebhookPayload>;

    try {
      messages = parseWebhookPayload(payload as never);
    } catch (error: unknown) {
      // A payload shape we cannot read must still be acknowledged, otherwise
      // Meta retries it forever. Record it and move on.
      logger.error({ error }, 'Failed to parse webhook payload');
      return reply.status(200).send({ success: true, data: { processed: 0, enqueued: 0 } });
    }

    let enqueued = 0;

    for (const message of messages) {
      if (!(await claimMessage(message.waMessageId))) {
        logger.debug({ waMessageId: message.waMessageId }, 'Duplicate webhook delivery ignored');
        continue;
      }

      try {
        await incomingMessagesQueue.add(
          // @ts-expect-error BullMQ v5 type inference issue
          'process-incoming-message',
          {
            businessPhoneNumberId: message.businessPhoneNumberId,
            waMessageId: message.waMessageId,
            message,
            receivedAt: new Date().toISOString(),
          },
          { jobId: `msg-${message.waMessageId}` },
        );
        enqueued += 1;
      } catch (error: unknown) {
        // Release the dedupe claim so Meta's retry can be processed.
        await redis.del(`${DEDUPE_KEY_PREFIX}${message.waMessageId}`).catch(() => undefined);
        logger.error(
          { error, waMessageId: message.waMessageId, from: maskPhone(message.from) },
          'Failed to enqueue inbound message',
        );
      }
    }

    // Coexistence: messages the owner sent from their own phone. Recorded
    // rather than enqueued — they need no classification, and running one
    // would have the assistant answer the owner's own words.
    let echoed = 0;

    for (const echo of parseEchoPayload(payload as never)) {
      if (!(await claimMessage(echo.waMessageId))) {
        logger.debug({ waMessageId: echo.waMessageId }, 'Duplicate echo delivery ignored');
        continue;
      }

      try {
        if (await recordAppEcho(echo)) {
          echoed += 1;
        }
      } catch (error: unknown) {
        await redis.del(`${DEDUPE_KEY_PREFIX}${echo.waMessageId}`).catch(() => undefined);
        logger.error(
          { error, waMessageId: echo.waMessageId, to: maskPhone(echo.to) },
          'Failed to record app echo',
        );
      }
    }

    const unhandled = describeUnhandledFields(payload as never);

    if (unhandled.length > 0) {
      logger.warn(
        { unhandled },
        'Webhook delivered fields nothing consumes yet — subscribed but dropped',
      );
    }

    logger.info({ received: messages.length, enqueued, echoed }, 'Webhook batch accepted');

      return reply.status(200).send({
        success: true,
        data: { processed: messages.length, enqueued, echoed },
      });
    },
  );
}
