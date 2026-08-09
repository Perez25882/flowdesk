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
  await notifyIntentReply(message.businessId, message.customer.id, templateKey);
}

const INTENT_TEMPLATE: Partial<Record<IntentType, TemplateKey>> = {
  [IntentType.GREETING]: 'greeting',
  [IntentType.PAYMENT]: 'payment',
  [IntentType.INQUIRY]: 'inquiry',
  [IntentType.COMPLAINT]: 'complaint',
};

async function processIntentClassification(jobData: IntentClassificationJobData): Promise<void> {
  const message = await fetchMessageWithCustomer(jobData.messageId);

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

  await prisma.message.update({
    where: { id: jobData.messageId },
    data: {
      intent: result.intent,
      intentConfidence: result.confidence,
      classifiedBy: result.source as ClassificationSource,
      processed: true,
      processedAt: new Date(),
    },
  });

  // Blacklist is enforced again inside the notification layer, but short-
  // circuiting here also avoids creating orders — and spending model calls —
  // for muted contacts.
  if (message.customer?.blacklisted) {
    logger.info(
      { messageId: jobData.messageId, customerId: message.customer.id },
      'Skipping intent side effects: customer is blacklisted',
    );
    await flagIfNeeded(jobData, result.intent, result.confidence, 'none', false);
    return;
  }

  if (result.intent === IntentType.STATUS_CHECK) {
    await flagIfNeeded(jobData, result.intent, result.confidence, 'none', false);
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
      : { action: 'template_reply' as const, escalated: false, intent: null, confidence: null };

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

  // `draft` sends the courtesy template too. The owner has a reply waiting, but
  // writing it takes them however long it takes, and leaving the customer with
  // silence in the meantime is worse than a holding message — the owner's real
  // answer follows it rather than replacing it.
  if (assisted.action === 'template_reply' || assisted.action === 'draft') {
    const templateKey = INTENT_TEMPLATE[finalIntent] ?? 'fallback';
    await handleAutoReplyIntent(message, templateKey);
  }
}

/**
 * Records whether a person needs to look at this, and tells the dashboard.
 *
 * Split out because it now depends on what the assistant did, which is only
 * known after it has run — the flag can no longer be written in the same update
 * as the classification.
 */
async function flagIfNeeded(
  jobData: IntentClassificationJobData,
  intent: IntentType,
  confidence: number,
  action: AssistantAction,
  escalated: boolean,
): Promise<void> {
  const needsReview = requiresReview(intent, confidence, action, escalated);

  await prisma.message.update({
    where: { id: jobData.messageId },
    data: { intent, intentConfidence: confidence, requiresReview: needsReview },
  });

  if (needsReview) {
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
