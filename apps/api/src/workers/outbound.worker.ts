import { Worker, UnrecoverableError } from 'bullmq';
import { MessageDirection, MessageType } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import { loadTenantCredentials, sendText } from '../services/whatsapp/client.js';
import { WhatsAppSendError, describeForOwner } from '../services/whatsapp/meta-errors.js';
import { recordOutboundConversation } from '../services/plan/plan.service.js';
import {
  OUTBOUND_MESSAGES_QUEUE_NAME,
  type OutboundJobData,
} from '../queues/outbound.queue.js';
import { moveToDeadLetter } from './dead-letter.worker.js';

/**
 * Delivers queued outbound messages through each tenant's own WhatsApp number.
 *
 * Concurrency is shared across tenants, but because a failing tenant's jobs fail
 * fast (permanent errors are not retried) one broken connection cannot occupy
 * the workers indefinitely.
 */
const WORKER_CONCURRENCY = 5;

/**
 * Writes the sent message into the conversation log.
 *
 * Without this the Messages view showed only the customer's half, so an owner
 * could not see what had been said on their behalf — and there was no record to
 * reconcile against Meta's conversation billing.
 */
async function recordSentMessage(
  data: OutboundJobData,
  waMessageId: string,
): Promise<void> {
  await prisma.message
    .create({
      data: {
        businessId: data.businessId,
        customerId: data.customerId,
        waMessageId,
        direction: MessageDirection.OUTBOUND,
        type: MessageType.TEXT,
        body: data.body,
        processed: true,
        processedAt: new Date(),
        relatedOrderId: data.relatedOrderId ?? null,
      },
    })
    .catch((error: unknown) => {
      // The customer already received the message; failing to log it must not
      // trigger a retry that would send it twice.
      logger.error(
        { error, businessId: data.businessId, waMessageId },
        'Delivered message but failed to record it',
      );
    });
}

async function processOutbound(data: OutboundJobData): Promise<void> {
  const credentials = await loadTenantCredentials(data.businessId);

  if (!credentials) {
    // Not connected, or connection rejected by Meta. Retrying cannot fix this;
    // the owner must reconnect, and they are told via connection state.
    throw new UnrecoverableError(
      `Business ${data.businessId} has no usable WhatsApp connection`,
    );
  }

  try {
    const result = await sendText(credentials, data.to, data.body);

    await Promise.all([
      recordSentMessage(data, result.waMessageId),
      recordOutboundConversation(data.businessId),
    ]);

    logger.info(
      {
        businessId: data.businessId,
        waMessageId: result.waMessageId,
        template: data.templateKey,
      },
      'Outbound WhatsApp message delivered',
    );
  } catch (error: unknown) {
    if (error instanceof WhatsAppSendError && !error.failure.retryable) {
      // Revoked token, closed 24h window, unreachable recipient — all permanent
      // for this message. Retrying wastes quota and delays other tenants.
      logger.warn(
        {
          businessId: data.businessId,
          kind: error.failure.kind,
          code: error.failure.code,
          guidance: describeForOwner(error.failure.kind),
        },
        'Outbound message permanently failed',
      );
      throw new UnrecoverableError(error.message);
    }

    throw error;
  }
}

export const outboundWorker = new Worker<OutboundJobData>(
  OUTBOUND_MESSAGES_QUEUE_NAME,
  async (job) => processOutbound(job.data),
  {
    // @ts-expect-error ioredis vs BullMQ bundled types
    connection: redisSubscriber,
    concurrency: WORKER_CONCURRENCY,
  },
);

outboundWorker.on('failed', async (job, error) => {
  if (!job) return;

  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  const permanent = error instanceof UnrecoverableError;

  if (exhausted || permanent) {
    logger.error(
      {
        error,
        businessId: job.data.businessId,
        attempts: job.attemptsMade,
        permanent,
      },
      'Outbound message abandoned',
    );

    await moveToDeadLetter(OUTBOUND_MESSAGES_QUEUE_NAME, job.id, job.data, error);
  }
});
