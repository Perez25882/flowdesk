import { Worker } from 'bullmq';
import { IntentType, type ClassificationSource } from '@flowdesk/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { redisSubscriber } from '../config/redis.js';
import { classifyMessage } from '../services/intent/index.js';
import { sendWhatsAppMessage } from '../services/whatsapp/outbound.js';
import {
  renderTemplate,
  humanizeStatus,
  getCustomerFirstName,
  shouldSendAutoReply,
  getTemplateKeyForOrderStatus,
  isTemplateEnabled,
} from '../services/templates/template-engine.js';
import { createOrderFromMessage } from '../modules/orders/orders.service.js';
import { findOrderByReference } from '../modules/orders/orders.repository.js';
import type { ParsedIncomingMessage } from '../modules/webhook/webhook.types.js';
import {
  INTENT_CLASSIFICATION_QUEUE_NAME,
} from './message-processor.worker.js';

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

async function fetchBusinessWithTemplates(businessId: string): Promise<{
  id: string;
  name: string;
  replyTemplates: Prisma.JsonValue;
  notifyOnNewOrder: boolean;
  notifyOnPayment: boolean;
  notifyOnLowStock: boolean;
}> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      replyTemplates: true,
      notifyOnNewOrder: true,
      notifyOnPayment: true,
      notifyOnLowStock: true,
    },
  });

  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  return business;
}

async function fetchMessageWithCustomer(messageId: string): Promise<{
  id: string;
  body: string | null;
  businessId: string;
  customerId: string | null;
  customer: { id: string; waNumber: string; name: string | null; lastInteractionAt: Date | null; blacklisted: boolean } | null;
}> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      customer: {
        select: {
          id: true,
          waNumber: true,
          name: true,
          lastInteractionAt: true,
          blacklisted: true,
        },
      },
    },
  });

  if (!message) {
    throw new Error(`Message not found: ${messageId}`);
  }

  return message;
}

async function handleOrderIntent(
  message: { id: string; body: string | null; businessId: string; customerId: string | null; customer: { id: string; waNumber: string; name: string | null; lastInteractionAt: Date | null } | null },
  business: { id: string; name: string; replyTemplates: Prisma.JsonValue },
): Promise<void> {
  if (!message.customerId || !message.customer) {
    logger.warn({ messageId: message.id }, 'Cannot create order: missing customer');
    return;
  }

  const parsedMessage: ParsedIncomingMessage = {
    businessPhoneNumberId: '',
    displayPhoneNumber: '',
    waMessageId: '',
    from: message.customer.waNumber,
    profileName: message.customer.name ?? undefined,
    timestamp: new Date(),
    type: 'TEXT',
    body: message.body ?? undefined,
    rawPayload: {
      from: message.customer?.waNumber ?? '',
      id: '',
      timestamp: String(Date.now()),
      type: 'text',
      text: { body: message.body ?? '' },
    },
  };

  try {
    const order = await createOrderFromMessage(parsedMessage, business.id, message.customerId);

    const templateKey = getTemplateKeyForOrderStatus('PENDING');
    if (templateKey && isTemplateEnabled(undefined, templateKey)) {
      const { withinWindow } = shouldSendAutoReply(message.customer.lastInteractionAt);
      if (withinWindow) {
        const text = renderTemplate(business.replyTemplates as Record<string, unknown> | undefined, templateKey, {
          name: getCustomerFirstName(message.customer.name),
          ref: order.referenceNumber,
          business: business.name,
        });
        await sendWhatsAppMessage(message.customer.waNumber, text, business.id);
      }
    }
  } catch (error: unknown) {
    logger.error({ error, messageId: message.id }, 'Failed to create order from message');
  }
}

async function handleStatusCheckIntent(
  message: { id: string; body: string | null; businessId: string; customer: { id: string; waNumber: string; name: string | null; lastInteractionAt: Date | null } | null },
  business: { id: string; name: string; replyTemplates: Prisma.JsonValue },
): Promise<void> {
  if (!message.customer) return;

  const body = message.body ?? '';
  const refMatch = body.match(/\bFD-\d{3,}\b/);
  const referenceNumber = refMatch ? refMatch[0] : null;

  if (!referenceNumber) {
    logger.info({ messageId: message.id }, 'STATUS_CHECK intent detected but no reference found in message');
    return;
  }

  const order = await findOrderByReference(referenceNumber, business.id);

  if (!order) {
    const text = `We couldn't find order ${referenceNumber}. Please check the reference number or contact us. — ${business.name}`;
    await sendWhatsAppMessage(message.customer.waNumber, text, business.id);
    return;
  }

  const templateKey = 'status_check_response';
  if (isTemplateEnabled(undefined, templateKey)) {
    const { withinWindow } = shouldSendAutoReply(message.customer.lastInteractionAt);
    if (withinWindow) {
      const details = order.assignedTo
        ? `Assigned to ${order.assignedTo.name} for delivery/pickup.`
        : '';
      const text = renderTemplate(business.replyTemplates as Record<string, unknown> | undefined, templateKey, {
        name: getCustomerFirstName(message.customer.name),
        ref: order.referenceNumber,
        business: business.name,
        status: humanizeStatus(order.status),
        details,
      });
      await sendWhatsAppMessage(message.customer.waNumber, text, business.id);
    }
  }
}

async function handleGreetingIntent(
  message: { id: string; businessId: string; customer: { id: string; waNumber: string; name: string | null; lastInteractionAt: Date | null } | null },
  business: { id: string; name: string; replyTemplates: Prisma.JsonValue },
): Promise<void> {
  if (!message.customer) return;

  const templateKey = 'greeting';
  if (isTemplateEnabled(undefined, templateKey)) {
    const { withinWindow } = shouldSendAutoReply(message.customer.lastInteractionAt);
    if (withinWindow) {
      const text = renderTemplate(business.replyTemplates as Record<string, unknown> | undefined, templateKey, {
        name: getCustomerFirstName(message.customer.name),
        business: business.name,
      });
      await sendWhatsAppMessage(message.customer.waNumber, text, business.id);
    }
  }
}

async function processIntentClassification(jobData: IntentClassificationJobData): Promise<void> {
  const message = await fetchMessageWithCustomer(jobData.messageId);
  const business = await fetchBusinessWithTemplates(jobData.businessId);

  if (!message.body) {
    logger.info({ messageId: jobData.messageId }, 'Skipping intent classification: message has no body');
    return;
  }

  const result = await classifyMessage(message.body);

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

  if (message.customer?.blacklisted) {
    logger.info({ messageId: jobData.messageId, customerId: message.customer.id }, 'Skipping auto-reply: customer is blacklisted');
    return;
  }

  switch (result.intent) {
    case IntentType.ORDER:
      await handleOrderIntent(message, business);
      break;
    case IntentType.STATUS_CHECK:
      await handleStatusCheckIntent(message, business);
      break;
    case IntentType.GREETING:
      await handleGreetingIntent(message, business);
      break;
    case IntentType.PAYMENT:
    case IntentType.INQUIRY:
    case IntentType.COMPLAINT:
    case IntentType.OTHER:
    case IntentType.UNCLASSIFIED:
    default:
      break;
  }
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

intentClassifierWorker.on('failed', (job, error) => {
  logger.error(
    {
      error,
      jobId: job?.id,
      messageId: job?.data.messageId,
      attemptsMade: job?.attemptsMade,
    },
    'Intent classification job exhausted or failed',
  );
});
