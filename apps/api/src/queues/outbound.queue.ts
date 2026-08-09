import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '../config/redis.js';

export const OUTBOUND_MESSAGES_QUEUE_NAME = 'outbound-messages';

export interface OutboundJobData {
  businessId: string;
  /** Customer this message belongs to, so the sent copy can be recorded. */
  customerId: string | null;
  to: string;
  body: string;
  /** Template that produced the text, for auditing which auto-reply fired. */
  templateKey?: string;
  /** Order the message concerns, when applicable. */
  relatedOrderId?: string;
}

/**
 * Outbound sending is queued rather than performed inline.
 *
 * With many tenants sharing the workers, an inline send meant one business with
 * a dead token or a slow Meta response delayed message processing for every
 * other business. Queuing gives each send its own retry budget and keeps the
 * ingestion path fast.
 *
 * Retries use exponential backoff starting at 5s; permanent failures (revoked
 * token, unreachable recipient) are detected by the worker and not retried.
 */
export const defaultOutboundJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: false,
};

export const outboundMessagesQueue = new Queue<OutboundJobData, unknown, string>(
  OUTBOUND_MESSAGES_QUEUE_NAME,
  {
    // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
    connection: redis,
    defaultJobOptions: defaultOutboundJobOptions,
  },
);

/** Enqueues a message for delivery through the owning tenant's own number. */
export async function enqueueOutboundMessage(data: OutboundJobData): Promise<void> {
  await outboundMessagesQueue.add(
    // @ts-expect-error BullMQ v5 NameType inference
    'send-whatsapp-message',
    data,
  );
}
