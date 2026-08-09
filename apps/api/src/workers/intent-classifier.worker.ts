import { Worker } from 'bullmq';
import { IntentType, type ClassificationSource } from '@flowdesk/shared';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import { emitMessageFlagged } from '../services/sse/sse.events.js';
import { classifyMessage } from '../services/intent/index.js';
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

const WORKER_CONCURRENCY = 3;

interface IntentClassificationJobData {
  businessId: string;
  messageId: string;
  waMessageId: string;
}

function requiresReviewByIntent(
  intent: IntentType,
  confidence: number,
): boolean {
  if (intent === IntentType.UNCLASSIFIED) return true;
  if (intent === IntentType.COMPLAINT) return true;
  if (intent === IntentType.INQUIRY) return true;
  if (intent === IntentType.PAYMENT) return true;
  if (confidence < 0.6) return true;
  return false;
}

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
  const needsReview = requiresReviewByIntent(result.intent, result.confidence);

  await prisma.message.update({
    where: { id: jobData.messageId },
    data: {
      intent: result.intent,
      intentConfidence: result.confidence,
      classifiedBy: result.source as ClassificationSource,
      processed: true,
      processedAt: new Date(),
      requiresReview: needsReview,
    },
  });

  if (needsReview) {
    emitMessageFlagged(jobData.businessId, {
      messageId: jobData.messageId,
      requiresReview: true,
      intent: result.intent,
    });
  }

  logger.info(
    {
      messageId: jobData.messageId,
      intent: result.intent,
      confidence: result.confidence,
      source: result.source,
      requiresReview: needsReview,
    },
    'Message intent classified',
  );

  // Blacklist is enforced again inside the notification layer, but short-
  // circuiting here also avoids creating orders for muted contacts.
  if (message.customer?.blacklisted) {
    logger.info(
      { messageId: jobData.messageId, customerId: message.customer.id },
      'Skipping intent side effects: customer is blacklisted',
    );
    return;
  }

  if (result.intent === IntentType.ORDER) {
    await handleOrderIntent(message);
    return;
  }

  if (result.intent === IntentType.STATUS_CHECK) {
    await handleStatusCheckIntent(message);
    return;
  }

  const templateKey = INTENT_TEMPLATE[result.intent] ?? 'fallback';
  await handleAutoReplyIntent(message, templateKey);
}

export const intentClassifierWorker = new Worker<IntentClassificationJobData>(
  INTENT_CLASSIFICATION_QUEUE_NAME,
  async (job) => {
    try {
      await processIntentClassification(job.data);
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
