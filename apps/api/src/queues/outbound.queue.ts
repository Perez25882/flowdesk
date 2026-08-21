import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '../config/redis.js';

export const OUTBOUND_MESSAGES_QUEUE_NAME = 'outbound-messages';

/**
 * An approved Meta message template, resolved and ready to send.
 *
 * Outside the 24-hour customer service window Meta accepts nothing else, so a
 * job that carries only free-form text is undeliverable there. Carrying the
 * template alongside the rendered text lets the worker pick the channel Meta
 * will actually accept while the conversation log still records the sentence
 * the customer read — the template and the free-form wording are kept identical
 * on purpose, so the log does not depend on which channel carried it.
 */
export interface OutboundTemplate {
  /** Name the template is registered under in the tenant's own WABA. */
  name: string;
  /** Language code the template was approved in. */
  language: string;
  /** Body parameters in `{{1}}`, `{{2}}`, … order. Meta rejects empty strings. */
  parameters: string[];
}

export interface OutboundJobData {
  businessId: string;
  /** Customer this message belongs to, so the sent copy can be recorded. */
  customerId: string | null;
  to: string;
  /**
   * The message as a person reads it.
   *
   * Always populated, template or not: it is what goes into the conversation
   * log, and it is what the worker sends when the window is open.
   */
  body: string;
  /**
   * Send this as an approved template instead of free-form text.
   *
   * Set only when the 24-hour window has closed. Present, the worker calls
   * `sendTemplate`; absent, `sendText`.
   */
  template?: OutboundTemplate;
  /** Template that produced the text, for auditing which auto-reply fired. */
  templateKey?: string;
  /** Order the message concerns, when applicable. */
  relatedOrderId?: string;
  /** The inbound message this answers, so the thread can be reconstructed. */
  inReplyToMessageId?: string;
  /** Set when a person sent this from the dashboard rather than automation. */
  sentByStaffId?: string;
  /**
   * Abort if the owner replied from their own phone after this moment.
   *
   * The takeover check runs when the message is queued, but generation and the
   * queue itself add seconds — long enough for the owner to start typing in the
   * WhatsApp Business app and for the assistant to then talk over them. The
   * worker re-checks this immediately before sending, which closes the window.
   *
   * Absent for human-initiated sends: refusing to deliver a person's own reply
   * because a person recently replied is nonsense.
   */
  suppressIfOwnerRepliedSince?: string;
}

export interface EnqueueOptions {
  /**
   * Identifies the EVENT being delivered, not the conversation it belongs to.
   *
   * BullMQ refuses a second job carrying an id it still holds, which makes this
   * a genuine exactly-once guard for something that can only correctly happen
   * once — one courtesy reply per inbound message, say. It is the wrong tool
   * for anything a person may legitimately repeat: `removeOnComplete` bounds
   * how long an id is remembered, so the suppression is silent, and arbitrary
   * in how long it lasts. A repeatable send must pass no key at all.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  /**
   * False when a job with the same idempotency key is already carrying this
   * send, so nothing new was queued.
   *
   * Returned rather than swallowed: a caller that only awaits the enqueue
   * cannot tell a delivery from a suppression, and that is precisely how a
   * message the owner believes was sent disappears without trace.
   */
  queued: boolean;
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
export async function enqueueOutboundMessage(
  data: OutboundJobData,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (!options.idempotencyKey) {
    await outboundMessagesQueue.add(
      // @ts-expect-error BullMQ v5 NameType inference
      'send-whatsapp-message',
      data,
    );
    return { queued: true };
  }

  // Asked before adding rather than inferred afterwards. `add` hands back the
  // job it already held with no indication that it did nothing, so the only way
  // to distinguish a delivery from a collision is to look first. The race
  // between the two calls is exactly the double-submit this is here to collapse
  // — BullMQ still keeps only one of them — so losing it costs a log line, not
  // a duplicate message.
  const existing = await outboundMessagesQueue.getJob(options.idempotencyKey);

  if (existing) {
    return { queued: false };
  }

  await outboundMessagesQueue.add(
    // @ts-expect-error BullMQ v5 NameType inference
    'send-whatsapp-message',
    data,
    { jobId: options.idempotencyKey },
  );

  return { queued: true };
}
