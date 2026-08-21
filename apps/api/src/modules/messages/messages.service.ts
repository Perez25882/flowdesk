import { createHash } from 'node:crypto';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { enqueueOutboundMessage } from '../../queues/outbound.queue.js';
import { loadTenantCredentials } from '../../services/whatsapp/client.js';
import { shouldSendAutoReply } from '../../services/templates/template-engine.js';
import { canSendOutbound } from '../../services/plan/plan.service.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import type {
  ListMessagesQueryInput,
  SendReplyInput,
  UpdateMessageIntentInput,
} from './messages.schema.js';
import * as repository from './messages.repository.js';

export async function listMessages(
  businessId: string,
  filters: ListMessagesQueryInput,
): Promise<repository.MessageWithCustomer[]> {
  return repository.listMessages(businessId, filters);
}

export async function updateMessageIntent(
  id: string,
  businessId: string,
  data: UpdateMessageIntentInput,
  correctedBy: string,
): Promise<repository.MessageWithCustomer> {
  return repository.updateMessageIntent(id, businessId, data, correctedBy);
}

export interface SendReplyResult {
  messageId: string;
  body: string;
  /** True when the text differs from what the assistant proposed. */
  edited: boolean;
  /**
   * True when this exact reply was already on its way and nothing new was
   * queued. The customer still receives the message — once.
   */
  duplicate: boolean;
}

/**
 * How long an identical reply to the same message counts as a double submit.
 *
 * Long enough to cover a double tap, a flaky connection retrying the POST and a
 * browser resubmitting on refresh. Short enough that an owner deliberately
 * sending the same words again — a nudge, a repeated price — is a new message
 * and goes out.
 */
const REPLY_DEDUPE_WINDOW_SECONDS = 60;

function replyClaimKey(messageId: string, body: string): string {
  const fingerprint = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `flowdesk:reply:${messageId}:${fingerprint}`;
}

/**
 * Claims the right to send this exact reply, once.
 *
 * The protection this replaces was `jobId: reply-<messageId>` on the outbound
 * job, which deduplicated on the conversation slot rather than on the request.
 * An owner sending a correction — "sorry, I meant GHS 620" — had it silently
 * dropped by BullMQ because it had seen that id before; the API answered 200,
 * the dashboard said sent, and the customer got the wrong price.
 *
 * That is the mirror image of the intent worker's problem, and the two resolve
 * in opposite directions on purpose. Automation answering the same message
 * twice is always a bug, so its guard is a durable marker on the message row.
 * A person replying twice is ordinary — corrections are the whole point — so
 * there is no message-level state to guard on, and the only thing worth
 * suppressing is the same REQUEST arriving twice. Hence a claim keyed on the
 * words being sent and expiring on a clock, rather than on a queue id whose
 * memory lasts however many jobs `removeOnComplete` happens to keep.
 *
 * Redis being unavailable lets the reply through, the same trade the owner
 * alert cooldown makes: a duplicate reply is a nuisance, a reply the owner
 * typed and that never arrived is the failure this function exists to prevent.
 */
async function claimReply(key: string): Promise<boolean> {
  try {
    const claimed = await redis.set(key, '1', 'EX', REPLY_DEDUPE_WINDOW_SECONDS, 'NX');
    return claimed === 'OK';
  } catch (error: unknown) {
    logger.warn({ error, key }, 'Reply de-duplication unavailable — sending anyway');
    return true;
  }
}

async function releaseReplyClaim(key: string): Promise<void> {
  await redis.del(key).catch(() => undefined);
}

/**
 * Sends a reply a person wrote or approved in the dashboard.
 *
 * Everything that can refuse the send is checked HERE, synchronously, so the
 * caller gets a real error. The alternative — enqueue and hope — is how a reply
 * disappears: the API answers 200, Meta rejects it as non-retryable, the job
 * dead-letters, and the owner is never told. From their side the app simply ate
 * their message.
 *
 * The draft is claimed conditionally, so two people tapping Send on the same
 * draft cannot both deliver it.
 */
export async function sendReply(
  messageId: string,
  businessId: string,
  data: SendReplyInput,
  staffId: string | null,
): Promise<SendReplyResult> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, businessId },
    select: {
      id: true,
      customerId: true,
      aiReplyText: true,
      aiReplyStatus: true,
      customer: {
        select: { id: true, waNumber: true, blacklisted: true, lastInboundAt: true },
      },
    },
  });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (!message.customer || !message.customerId) {
    throw new ValidationError('This message has no customer to reply to');
  }

  if (message.customer.blacklisted) {
    throw new ValidationError('This customer is blocked. Unblock them to reply.');
  }

  // Meta's rule, checked before we accept rather than after we fail.
  if (!shouldSendAutoReply(message.customer.lastInboundAt).withinWindow) {
    throw new ValidationError(
      'You can only send a free-form message within 24 hours of the customer’s last message. They need to message you again first.',
    );
  }

  // Connection state, for the same reason: an unconnected number produces an
  // unrecoverable job, not a retry.
  const credentials = await loadTenantCredentials(businessId);

  if (!credentials) {
    throw new ValidationError(
      'WhatsApp is not connected. Reconnect it in Settings to send messages.',
    );
  }

  if (!(await canSendOutbound(businessId))) {
    throw new ValidationError(
      'Your plan’s conversation allowance is used up for this month. Upgrade to keep replying.',
    );
  }

  // Claim the draft. `updateMany` with the expected status is atomic, so only
  // one of two concurrent clicks can transition it — the same idiom used for
  // WhatsApp connection state. A message with no draft is still replyable.
  if (message.aiReplyStatus === 'DRAFT') {
    const claim = await prisma.message.updateMany({
      where: { id: messageId, businessId, aiReplyStatus: 'DRAFT' },
      data: { aiReplyStatus: 'SENT' },
    });

    if (claim.count === 0) {
      throw new ConflictError('This reply was already sent or dismissed.');
    }
  }

  const edited = message.aiReplyText !== null && message.aiReplyText !== data.body;
  const claimKey = replyClaimKey(messageId, data.body);

  if (!(await claimReply(claimKey))) {
    // Not an error and not a drop: this exact text is already on its way to
    // this customer. Reported rather than swallowed so the caller can tell one
    // delivery from two, which is the whole complaint against the jobId this
    // replaces.
    logger.info(
      { businessId, messageId, staffId },
      'Duplicate reply submission collapsed — the identical text is already queued',
    );

    return { messageId, body: data.body, edited, duplicate: true };
  }

  try {
    // No idempotency key on the job. A second reply to the same message is an
    // ordinary thing for an owner to send, and BullMQ has no way to report that
    // it refused one.
    await enqueueOutboundMessage({
      businessId,
      customerId: message.customerId,
      to: message.customer.waNumber,
      body: data.body,
      inReplyToMessageId: message.id,
      ...(staffId ? { sentByStaffId: staffId } : {}),
    });
  } catch (error: unknown) {
    // Release both claims so the owner can try again rather than being told for
    // the next minute that their own reply is a duplicate.
    await releaseReplyClaim(claimKey);

    if (message.aiReplyStatus === 'DRAFT') {
      await prisma.message
        .updateMany({
          where: { id: messageId, businessId, aiReplyStatus: 'SENT' },
          data: { aiReplyStatus: 'DRAFT' },
        })
        .catch(() => undefined);
    }
    throw error;
  }

  if (staffId) {
    await logActivity({
      staffId,
      action: 'message.reply',
      resourceId: messageId,
      resourceType: 'message',
      note: 'Replied to a customer',
    }).catch(() => undefined);
  }

  logger.info(
    { businessId, messageId, staffId, hadDraft: message.aiReplyText !== null, edited },
    'Reply sent from dashboard',
  );

  return { messageId, body: data.body, edited, duplicate: false };
}

/** Discards a draft the owner does not want to send. */
export async function dismissDraft(messageId: string, businessId: string): Promise<void> {
  const dismissed = await prisma.message.updateMany({
    where: { id: messageId, businessId, aiReplyStatus: 'DRAFT' },
    data: { aiReplyStatus: 'DISMISSED' },
  });

  if (dismissed.count === 0) {
    throw new NotFoundError('No draft to dismiss');
  }
}
