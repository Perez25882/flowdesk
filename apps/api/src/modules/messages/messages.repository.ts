import { prisma } from '../../config/database.js';
import { Prisma, IntentType, ClassificationSource } from '@prisma/client';
import type { ListMessagesQueryInput, UpdateMessageIntentInput } from './messages.schema.js';

/**
 * The API's message shape.
 *
 * Hand-written and applied with a cast, so adding a Prisma column does NOT make
 * it appear here — the cast will happily claim a field the response never
 * carried. Anything the dashboard needs has to be listed.
 */
export interface MessageWithCustomer {
  id: string;
  waMessageId: string;
  direction: string;
  type: string;
  body: string | null;
  intent: string;
  intentConfidence: number | null;
  classifiedBy: string | null;
  requiresReview: boolean;
  processed: boolean;
  relatedOrderId: string | null;
  /** A reply the assistant wrote for this message, if any. */
  aiReplyText: string | null;
  aiReplyStatus: string | null;
  aiValidationFailed: string[];
  createdAt: Date;
  customer: { id: string; name: string | null; waNumber: string } | null;
}

export async function listMessages(
  businessId: string,
  filters: ListMessagesQueryInput,
): Promise<MessageWithCustomer[]> {
  const where: Prisma.MessageWhereInput = { businessId };
  if (filters.requiresReview !== undefined) where.requiresReview = filters.requiresReview;
  if (filters.intent) where.intent = filters.intent as IntentType;

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return messages as MessageWithCustomer[];
}

export async function updateMessageIntent(
  id: string,
  businessId: string,
  data: UpdateMessageIntentInput,
  correctedBy: string,
): Promise<MessageWithCustomer> {
  const message = await prisma.message.findFirst({
    where: { id, businessId },
    include: { customer: { select: { id: true, name: true, waNumber: true } } },
  });
  if (!message) throw new Error('Message not found');

  await prisma.intentCorrection.create({
    data: {
      businessId,
      messageId: id,
      originalIntent: message.intent,
      correctedIntent: data.intent as IntentType,
      originalSource: message.classifiedBy as ClassificationSource | null,
      originalConfidence: message.intentConfidence,
      correctedBy,
    },
  });

  const updated = await prisma.message.update({
    where: { id },
    data: {
      intent: data.intent as IntentType,
      classifiedBy: 'MANUAL',
      requiresReview: false,
    },
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return updated as MessageWithCustomer;
}
