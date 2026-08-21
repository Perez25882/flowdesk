import { Worker, UnrecoverableError } from 'bullmq';
import { MessageDirection, MessageType } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import {
  loadTenantCredentials,
  sendTemplate,
  sendText,
  type SendResult,
  type TenantCredentials,
} from '../services/whatsapp/client.js';
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
        inReplyToMessageId: data.inReplyToMessageId ?? null,
        sentByStaffId: data.sentByStaffId ?? null,
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

/**
 * Sends the job through the channel Meta will accept for it.
 *
 * The branch is the whole point of `template` being on the job. Inside the
 * 24-hour window a free-form text is cheaper, carries the owner's own wording,
 * and needs no approval. Outside it Meta rejects free-form outright, so a job
 * queued there used to be enqueued, rejected as non-retryable and dead-lettered
 * — or, before that, dropped at the gate with nothing but a log line while the
 * owner believed the customer had been told.
 */
async function send(
  credentials: TenantCredentials,
  data: OutboundJobData,
): Promise<SendResult> {
  if (!data.template) {
    return sendText(credentials, data.to, data.body);
  }

  return sendTemplate(
    credentials,
    data.to,
    data.template.name,
    data.template.language,
    data.template.parameters.length > 0
      ? [
          {
            type: 'body',
            parameters: data.template.parameters.map((text) => ({ type: 'text', text })),
          },
        ]
      : undefined,
  );
}

/**
 * True when the owner started answering from their own phone after this job was
 * queued.
 *
 * The takeover gate runs at enqueue time, but generation plus queue latency can
 * be several seconds — ample time for the owner to begin replying in the
 * WhatsApp Business app. Re-checking here, immediately before the send, closes
 * that window; without it the assistant talks over a human mid-conversation,
 * which is the failure most likely to make an owner switch the product off.
 */
async function ownerTookOver(data: OutboundJobData): Promise<boolean> {
  if (!data.suppressIfOwnerRepliedSince || !data.customerId) return false;

  const since = new Date(data.suppressIfOwnerRepliedSince);

  const takeover = await prisma.message.findFirst({
    where: { customerId: data.customerId, sentFromApp: true, createdAt: { gt: since } },
    select: { id: true },
  });

  return takeover !== null;
}

async function processOutbound(data: OutboundJobData): Promise<void> {
  if (await ownerTookOver(data)) {
    logger.info(
      { businessId: data.businessId, customerId: data.customerId },
      'Outbound message dropped: owner answered from the WhatsApp Business app while it was queued',
    );
    return;
  }

  const credentials = await loadTenantCredentials(data.businessId);

  if (!credentials) {
    // Not connected, or connection rejected by Meta. Retrying cannot fix this;
    // the owner must reconnect, and they are told via connection state.
    throw new UnrecoverableError(
      `Business ${data.businessId} has no usable WhatsApp connection`,
    );
  }

  try {
    const result = await send(credentials, data);

    // Both channels are recorded identically. Meta bills a template
    // conversation exactly as it bills a free-form one, so an accounting path
    // that only counted `sendText` would under-report the tenant's usage — and
    // a conversation log missing the template sends would show the customer
    // being ignored for a day when they had in fact been told.
    await Promise.all([
      recordSentMessage(data, result.waMessageId),
      recordOutboundConversation(data.businessId),
    ]);

    logger.info(
      {
        businessId: data.businessId,
        waMessageId: result.waMessageId,
        template: data.templateKey,
        channel: data.template ? 'template' : 'text',
        metaTemplate: data.template?.name,
      },
      'Outbound WhatsApp message delivered',
    );
  } catch (error: unknown) {
    if (error instanceof WhatsAppSendError && !error.failure.retryable) {
      // Revoked token, closed 24h window, unreachable recipient — all permanent
      // for this message. Retrying wastes quota and delays other tenants.
      // A missing or paused template is the one permanent failure an operator
      // can actually fix, and the one that hits every newly onboarded tenant,
      // so it is logged at error with the template named rather than folded in
      // with unreachable recipients. It still dead-letters below: this message
      // is lost, and the record of it has to say so rather than imply the
      // customer was reached.
      const level = error.failure.kind === 'TEMPLATE_UNAVAILABLE' ? 'error' : 'warn';

      logger[level](
        {
          businessId: data.businessId,
          kind: error.failure.kind,
          code: error.failure.code,
          metaTemplate: data.template?.name,
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
