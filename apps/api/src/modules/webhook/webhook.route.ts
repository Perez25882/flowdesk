import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../config/logger.js';
import { acceptTextReceipts } from './text-receipts.js';
import type { MetaWebhookPayload } from './webhook.types.js';
import {
  describeUnhandledFields,
  handleVerification,
  isMediaMessage,
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

      let payload: MetaWebhookPayload;

      try {
        payload = JSON.parse(rawBodyBuffer.toString());
      } catch {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid JSON payload', code: 'INVALID_JSON' });
      }

      if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry) ||
          !payload.entry.some((entry) => Array.isArray(entry?.changes) && entry.changes.some((change) =>
            typeof change?.field === 'string' && change.value !== null && typeof change.value === 'object' && !Array.isArray(change.value)))) {
        return reply.status(400).send({ success: false, code: 'INVALID_WHATSAPP_ENVELOPE' });
      }

      const messages = parseWebhookPayload(payload);
      const echoes = parseEchoPayload(payload);
      const hasMessageMembers = payload.entry.some((entry) => Array.isArray(entry?.changes) &&
        entry.changes.some((change) => (
          (change?.field === 'messages' && Array.isArray(change.value?.messages) && change.value.messages.length > 0) ||
          (change?.field === 'smb_message_echoes' && Array.isArray(change.value?.message_echoes) && change.value.message_echoes.length > 0)
        )));
      const texts = messages.filter((message) => message.type === 'TEXT');
      const mediaCount = messages.filter((message) => isMediaMessage(message.type)).length;
      const interactions = messages.length - texts.length - mediaCount;
      try {
        await acceptTextReceipts(messages, echoes);
      } catch {
        logger.error({ eventCount: messages.length + echoes.length }, 'Could not commit WhatsApp receipts');
        return reply.status(503).send({
          success: false,
          error: 'Could not accept WhatsApp events. Retry this delivery.',
          code: messages.length === texts.length && !echoes.length ? 'TEXT_RECEIPT_UNAVAILABLE' : 'WHATSAPP_RECEIPT_UNAVAILABLE',
        });
      }

      const unhandled = describeUnhandledFields(payload);

      if (unhandled.length > 0) {
        logger.warn(
          { unhandled },
          'Webhook delivered fields nothing consumes yet — subscribed but dropped',
        );
      }
      if (hasMessageMembers && messages.length + echoes.length === 0) {
        logger.info('Signed WhatsApp batch contained no supported valid message members');
      }

      logger.info(
        { received: messages.length, acceptedText: texts.length, acceptedMedia: mediaCount, acceptedEchoes: echoes.length },
        'Webhook batch accepted',
      );

      return reply.status(200).send({
        success: true,
        data: {
          processed: messages.length, acceptedText: texts.length, enqueued: 0, echoed: 0,
          ...(mediaCount ? { acceptedMedia: mediaCount } : {}),
          ...(echoes.length ? { acceptedEchoes: echoes.length } : {}),
          ...(interactions ? { acceptedInteractions: interactions } : {}),
        },
      });
    },
  );
}
