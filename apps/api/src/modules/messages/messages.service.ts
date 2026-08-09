import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
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

  try {
    await enqueueOutboundMessage(
      {
        businessId,
        customerId: message.customerId,
        to: message.customer.waNumber,
        body: data.body,
        inReplyToMessageId: message.id,
        ...(staffId ? { sentByStaffId: staffId } : {}),
      },
      // Idempotency: a retried request or a double submit collapses to one job.
      { jobId: `reply-${messageId}` },
    );
  } catch (error: unknown) {
    // Release the claim so the owner can try again rather than losing the draft.
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

  const edited = message.aiReplyText !== null && message.aiReplyText !== data.body;

  logger.info(
    { businessId, messageId, staffId, hadDraft: message.aiReplyText !== null, edited },
    'Reply sent from dashboard',
  );

  return { messageId, body: data.body, edited };
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
