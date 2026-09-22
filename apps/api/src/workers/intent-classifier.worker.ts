import { Worker } from 'bullmq';
import { IntentType, type AssistantAction, type ClassificationSource } from '@flowdesk/shared';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import { emitMessageFlagged } from '../services/sse/sse.events.js';
import { classifyMessage } from '../services/intent/index.js';
import { runAssistant } from '../services/assistant/index.js';
import { requiresReview } from '../services/assistant/router.js';
import {
  notifyAssistantHold,
  notifyIntentReply,
  notifyOrderStatus,
  notifyOrderStatusCheck,
  notifyUnknownOrderReference,
} from '../services/notifications/customer-notifications.js';
import type { TemplateKey } from '../services/templates/template-engine.js';
import { createOrderFromMessage } from '../modules/orders/orders.service.js';
import { findOrderByReference } from '../modules/orders/orders.repository.js';
import { findActiveCatalogProducts } from '../modules/products/products.repository.js';
import {
  INTENT_CLASSIFICATION_QUEUE_NAME,
} from './message-processor.worker.js';
import { moveToDeadLetter } from './dead-letter.worker.js';
import { withTenantSlot } from './tenant-fairness.js';

/**
 * Raised from 3 once the assistant landed.
 *
 * The job is almost entirely waiting on a model — measured at 2–4s per call —
 * so at 3 the whole platform handled roughly 50 messages a minute regardless of
 * how many tenants were sending. The work is I/O, not CPU, so the ceiling is the
 * provider's rate limit rather than this number; per-tenant fairness (below)
 * keeps one busy shop from taking every slot.
 */
const WORKER_CONCURRENCY = 10;

interface IntentClassificationJobData {
  businessId: string;
  messageId: string;
  waMessageId: string;
}

/**
 * Intents the assistant handles instead of a template.
 *
 * ORDER is included now that pending orders exist to hold an incomplete one
 * between turns — before that, an ambiguous order would have been held and then
 * silently forgotten, which is worse than the generic reply it replaced. The
 * old record-driven path is still the fallback when the assistant does not run.
 *
 * STATUS_CHECK is deliberately left out: looking up a reference number is an
 * exact database lookup with a templated answer, and a model adds latency and
 * failure modes to something that already works.
 */
const ASSISTANT_INTENTS: ReadonlySet<IntentType> = new Set([
  IntentType.ORDER,
  IntentType.INQUIRY,
  IntentType.PAYMENT,
  IntentType.COMPLAINT,
  IntentType.GREETING,
  IntentType.OTHER,
  IntentType.UNCLASSIFIED,
]);

interface ClassifiedMessage {
  id: string;
  body: string | null;
  businessId: string;
  customerId: string | null;
  /** True once this message has been carried through the pipeline. */
  processed: boolean;
  /** Prisma types this as a string union, and the SSE payload takes a string. */
  intent: string;
  customer: { id: string; waNumber: string; name: string | null; blacklisted: boolean } | null;
}

async function fetchMessageWithCustomer(messageId: string): Promise<ClassifiedMessage> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      body: true,
      businessId: true,
      customerId: true,
      processed: true,
      intent: true,
      customer: {
        select: { id: true, waNumber: true, name: true, blacklisted: true },
      },
    },
  });

  if (!message) {
    throw new Error(`Message not found: ${messageId}`);
  }

  return message;
}

/**
 * Turns an ORDER-intent message into an order record. The customer confirmation
 * is sent by `notifyOrderStatus` here — `createOrderFromMessage` deliberately
 * does not reply, so exactly one confirmation goes out per order.
 */
async function handleOrderIntent(message: ClassifiedMessage): Promise<void> {
  if (!message.customerId || !message.customer) {
    logger.warn({ messageId: message.id }, 'Cannot create order: missing customer');
    return;
  }

  try {
    const order = await createOrderFromMessage(
      message.body ?? '',
      message.businessId,
      message.customerId,
    );

    await prisma.message.update({
      where: { id: message.id },
      data: { relatedOrderId: order.id },
    });

    await notifyOrderStatus(order.id, 'PENDING');
  } catch (error: unknown) {
    logger.error({ error, messageId: message.id }, 'Failed to create order from message');
  }
}

/** Answers "where is my order?" when the message carries a reference number. */
async function handleStatusCheckIntent(message: ClassifiedMessage): Promise<void> {
  if (!message.customer) return;

  const refMatch = (message.body ?? '').match(/\bFD-[A-Z0-9]{3,}\b/i);

  if (!refMatch) {
    logger.info(
      { messageId: message.id },
      'STATUS_CHECK intent detected but no reference found in message',
    );
    return;
  }

  const reference = refMatch[0].toUpperCase();
  const order = await findOrderByReference(reference, message.businessId);

  if (!order) {
    await notifyUnknownOrderReference(message.businessId, message.customer.id, reference);
    return;
  }

  await prisma.message.update({
    where: { id: message.id },
    data: { relatedOrderId: order.id },
  });

  await notifyOrderStatusCheck(order.id);
}

/** Sends the configured courtesy reply for a non-order intent. */
async function handleAutoReplyIntent(
  message: ClassifiedMessage,
  templateKey: TemplateKey,
): Promise<void> {
  if (!message.customer) return;
  await notifyIntentReply(message.businessId, message.customer.id, templateKey, message.id);
}

const INTENT_TEMPLATE: Partial<Record<IntentType, TemplateKey>> = {
  [IntentType.GREETING]: 'greeting',
  [IntentType.PAYMENT]: 'payment',
  [IntentType.INQUIRY]: 'inquiry',
  [IntentType.COMPLAINT]: 'complaint',
};

/**
 * The one thing this worker must never do twice: answer the same message.
 *
 * `runAssistant` sends from inside itself — `deliverText` runs before this
 * function has finished its own bookkeeping — so any write after it can throw,
 * fail the job, and hand BullMQ a retry that starts again from the top:
 * reclassify, re-run the assistant, ask the customer the identical question a
 * second time with the clarification counter now reading two. There was nothing
 * on the row saying it had already been answered, and the outbound job carried
 * no key, so both copies went out.
 *
 * `processed` is that marker. It is written in the same update as the
 * classification and the provisional review flag, which is BEFORE anything is
 * sent, so a retry that finds it set knows the first attempt got at least as far
 * as deciding what to do — and that whatever happened after, doing it again
 * means talking to the customer twice. An attempt that died earlier leaves it
 * false and is retried in full, which is what the retry budget is for.
 *
 * The message is flagged for review on the way out. A retry only happens because
 * something failed mid-flight, and from here there is no way to tell whether the
 * customer was answered before it did. Putting the message in front of a person
 * is the only resolution that does not quietly gamble on one of the two.
 */
async function abandonRetryOfHandledMessage(message: ClassifiedMessage): Promise<void> {
  logger.warn(
    { messageId: message.id, businessId: message.businessId, intent: message.intent },
    'Intent classification retried for a message already handled — not answering it again',
  );

  await prisma.message
    .update({ where: { id: message.id }, data: { requiresReview: true } })
    .catch((error: unknown) => {
      logger.error(
        { error, messageId: message.id },
        'Failed to flag a retried message for review',
      );
    });

  emitMessageFlagged(message.businessId, {
    messageId: message.id,
    requiresReview: true,
    intent: message.intent,
  });
}

async function processIntentClassification(jobData: IntentClassificationJobData): Promise<void> {
  const message = await fetchMessageWithCustomer(jobData.messageId);

  if (message.processed) {
    await abandonRetryOfHandledMessage(message);
    return;
  }

  // A message with no text (media, sticker) still has to be marked processed,
  // otherwise it sits in the queue view as "pending" forever.
  if (!message.body) {
    await prisma.message.update({
      where: { id: jobData.messageId },
      data: { processed: true, processedAt: new Date() },
    });
    logger.info(
      { messageId: jobData.messageId },
      'Message has no text body — marked processed without classification',
    );
    return;
  }

  // The classifier is given this tenant's catalog only — never another's — so
  // product evidence stays scoped to the business the message was sent to.
  const catalog = await findActiveCatalogProducts(jobData.businessId);
  const catalogTerms = catalog.flatMap((product) => [product.name, ...product.aliases]);

  const result = await classifyMessage(message.body, message.businessId, { catalogTerms });

  // The review flag is written here, with the classification, rather than only
  // after the assistant has run. It used to be the last statement in the
  // function, which meant the single failure this whole guard exists for — a
  // write dying after the customer had already been answered — also lost the
  // flag, and a message that needed a person never appeared in the review
  // queue. Computed from the rule engine alone, with the action `none` because
  // nothing has been done to the message yet; the call below refines it once
  // the assistant has had its say.
  const provisionalReview = requiresReview(result.intent, result.confidence, 'none', false);

  await prisma.message.update({
    where: { id: jobData.messageId },
    data: {
      intent: result.intent,
      intentConfidence: result.confidence,
      classifiedBy: result.source as ClassificationSource,
      processed: true,
      processedAt: new Date(),
      requiresReview: provisionalReview,
    },
  });

  if (provisionalReview) {
    emitMessageFlagged(jobData.businessId, {
      messageId: jobData.messageId,
      requiresReview: true,
      intent: result.intent,
    });
  }

  // Blacklist is enforced again inside the notification layer, but short-
  // circuiting here also avoids creating orders — and spending model calls —
  // for muted contacts.
  if (message.customer?.blacklisted) {
    logger.info(
      { messageId: jobData.messageId, customerId: message.customer.id },
      'Skipping intent side effects: customer is blacklisted',
    );
    return;
  }

  if (result.intent === IntentType.STATUS_CHECK) {
    await handleStatusCheckIntent(message);
    return;
  }

  // The assistant reads the message against this shop's catalogue and facts, and
  // either answers it, asks about it, or writes the owner a draft. It falls back
  // to the template when it is switched off, unconfigured, or unavailable.
  const assisted =
    ASSISTANT_INTENTS.has(result.intent) && message.customerId
      ? await runAssistant({
          businessId: message.businessId,
          customerId: message.customerId,
          messageId: message.id,
          body: message.body,
          ruleIntent: result.intent,
          ruleConfidence: result.confidence,
        })
      : {
          action: 'template_reply' as const,
          escalated: false,
          intent: null,
          confidence: null,
          holdingText: null,
        };

  // The assistant reads the message with the shop's catalogue in front of it, so
  // where it disagrees with the rule engine it is better informed.
  const finalIntent = assisted.intent ?? result.intent;
  const finalConfidence = assisted.confidence ?? result.confidence;

  await flagIfNeeded(
    jobData,
    finalIntent,
    finalConfidence,
    assisted.action,
    assisted.escalated,
    provisionalReview,
  );

  logger.info(
    {
      messageId: jobData.messageId,
      intent: finalIntent,
      confidence: finalConfidence,
      source: result.source,
      assistantAction: assisted.action,
    },
    'Message intent classified',
  );

  // The assistant did not run, and this is an order. Fall back to the old
  // record-driven path so an order is still created — degrading to "no order
  // was taken" would cost the owner a sale.
  if (assisted.action === 'template_reply' && result.intent === IntentType.ORDER) {
    await handleOrderIntent(message);
    return;
  }

  // `draft` answers the customer too. The owner has a reply waiting, but writing
  // it takes them however long it takes, and leaving the customer with silence
  // in the meantime is worse than a holding message — the owner's real answer
  // follows it rather than replacing it.
  //
  // What gets sent matters as much as that it is sent. The courtesy template —
  // "Thanks for your question. Please share more details and we'll get back to
  // you right away" — asks a customer who has just asked a perfectly clear
  // question to ask it again, and it is identical for every shop and every
  // message. When the assistant produced a holding line naming what they
  // actually asked about, that goes instead; the template is what is left when
  // the assistant produced nothing at all.
  if (assisted.action === 'template_reply' || assisted.action === 'draft') {
    // Resolved before the branch because both paths are the same reply as far
    // as the owner is concerned. The holding line replaces this template; it
    // must not escape the switch that governs it just by taking the other road.
    const templateKey = INTENT_TEMPLATE[finalIntent] ?? 'fallback';

    if (assisted.holdingText && message.customer) {
      await notifyAssistantHold(
        message.businessId,
        message.customer.id,
        assisted.holdingText,
        message.id,
        templateKey,
      );
      return;
    }

    await handleAutoReplyIntent(message, templateKey);
  }
}

/**
 * Refines the review flag once the assistant's answer is known.
 *
 * A separate write from the classification because it depends on what the
 * assistant did, which is only known after it has run — and because the
 * assistant has already spoken to the customer by then, this write failing must
 * not be allowed to re-send anything. That is what the guard at the top of
 * `processIntentClassification` is for, and why a provisional flag was written
 * before the assistant ran: if this write never lands, the row still carries the
 * rule engine's verdict rather than nothing at all.
 */
async function flagIfNeeded(
  jobData: IntentClassificationJobData,
  intent: IntentType,
  confidence: number,
  action: AssistantAction,
  escalated: boolean,
  alreadyFlagged: boolean,
): Promise<void> {
  const needsReview = requiresReview(intent, confidence, action, escalated);

  await prisma.message.update({
    where: { id: jobData.messageId },
    data: { intent, intentConfidence: confidence, requiresReview: needsReview },
  });

  // Only on the transition. The dashboard was already told when the provisional
  // flag went on, and a second identical event just makes the review queue
  // flicker.
  if (needsReview && !alreadyFlagged) {
    emitMessageFlagged(jobData.businessId, {
      messageId: jobData.messageId,
      requiresReview: true,
      intent,
    });
  }
}

export const intentClassifierWorker = new Worker<IntentClassificationJobData>(
  INTENT_CLASSIFICATION_QUEUE_NAME,
  async (job) => {
    try {
      await withTenantSlot(job.data.businessId, () => processIntentClassification(job.data));
    } catch (error: unknown) {
      logger.error(
        {
          error,
          jobId: job.id,
          messageId: job.data.messageId,
          businessId: job.data.businessId,
        },
        'Intent classification job failed',
      );
      throw error;
    }
  },
  {
    // @ts-expect-error ioredis v5.11.0 vs BullMQ bundled v5.10.1 type mismatch
    connection: redisSubscriber,
    concurrency: WORKER_CONCURRENCY,
  },
);

intentClassifierWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, messageId: job.data.messageId }, 'Intent classification completed');
});

intentClassifierWorker.on('failed', async (job, error) => {
  logger.error(
    {
      error,
      jobId: job?.id,
      messageId: job?.data.messageId,
      attemptsMade: job?.attemptsMade,
    },
    'Intent classification job exhausted or failed',
  );

  if (job && job.attemptsMade >= 3) {
    await moveToDeadLetter(INTENT_CLASSIFICATION_QUEUE_NAME, job.id, job.data, error);
  }
});
