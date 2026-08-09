import type { PendingOrder, Prisma } from '@prisma/client';
import type { AssistantProductMention, ClarificationField } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';

/**
 * An order held open across turns, while we work out what the customer wants.
 *
 * The alternative — create the `Order` on the first hint and patch it — puts
 * half-formed rows in front of the owner and bills them against the plan before
 * anyone has agreed to buy anything. Nothing becomes an `Order` here until the
 * customer has actually said what they want.
 *
 * Three things make this safe against a customer sending two messages at once:
 *
 *   1. A Redis mutex per conversation, so the second message waits.
 *   2. A partial unique index, so if it does not wait, the database refuses.
 *   3. `resolvedOrderId`, claimed conditionally, so a pending order can convert
 *      to a real order exactly once even if two workers try.
 */

/** How long a half-finished order stays answerable. */
const EXPIRY_HOURS = 48;

/**
 * Evaluated on read rather than swept by a job.
 *
 * This repo has no scheduler, and adding one to expire a handful of rows would
 * be a lot of moving parts for a timestamp comparison any read can do — the same
 * reasoning as the monthly counter reset in `plan.service.ts`.
 */
function isExpired(pending: Pick<PendingOrder, 'expiresAt'>, now = new Date()): boolean {
  return pending.expiresAt <= now;
}

export function expiresAtFrom(now = new Date()): Date {
  return new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
}

/** One conversation at a time, so two rapid messages cannot both open a draft. */
function mutexKey(businessId: string, customerId: string): string {
  return `flowdesk:convo:${businessId}:${customerId}`;
}

const MUTEX_TTL_SECONDS = 30;

/**
 * Same `SET NX` shape as the send-slot reservation in `whatsapp/client.ts`.
 *
 * Returns a release function rather than a boolean so a caller cannot forget
 * which key it took. A failed acquire returns null and the caller skips —
 * dropping the second of two simultaneous messages is better than answering it
 * against state the first one is still changing.
 */
export async function withConversationLock<T>(
  businessId: string,
  customerId: string,
  work: () => Promise<T>,
): Promise<T | null> {
  const key = mutexKey(businessId, customerId);
  let acquired = false;

  try {
    acquired = (await redis.set(key, '1', 'EX', MUTEX_TTL_SECONDS, 'NX')) === 'OK';
  } catch {
    // Redis down: proceed anyway. The partial unique index is the real guard,
    // and refusing to answer customers because a cache is unavailable is worse
    // than the rare double-draft it would prevent.
    logger.warn({ businessId, customerId }, 'Conversation lock unavailable — proceeding');
    return work();
  }

  if (!acquired) return null;

  try {
    return await work();
  } finally {
    await redis.del(key).catch(() => {
      // The TTL clears it either way.
    });
  }
}

/**
 * The open pending order for this conversation, if there is a live one.
 *
 * Expiring on read keeps a stale draft from silently swallowing an unrelated
 * message two days later: "2 bags" answering a question nobody remembers asking.
 */
export async function findOpenPendingOrder(
  businessId: string,
  customerId: string,
): Promise<PendingOrder | null> {
  const pending = await prisma.pendingOrder.findFirst({
    where: { businessId, customerId, status: 'AWAITING_REPLY' },
    orderBy: { createdAt: 'desc' },
  });

  if (!pending) return null;

  if (isExpired(pending)) {
    await prisma.pendingOrder
      .updateMany({
        where: { id: pending.id, status: 'AWAITING_REPLY' },
        data: { status: 'EXPIRED' },
      })
      .catch((error: unknown) => {
        logger.warn({ error, pendingOrderId: pending.id }, 'Failed to expire a pending order');
      });

    return null;
  }

  return pending;
}

export interface RecordQuestionInput {
  businessId: string;
  customerId: string;
  messageId: string;
  question: string;
  missing: ClarificationField[];
  draftItems: AssistantProductMention[];
  /** The row being continued, when this is not the first question. */
  existing: PendingOrder | null;
}

/**
 * Records that we have asked something and are now waiting.
 *
 * Creating and continuing are the same call because the caller does not care
 * which it is: it has asked a question, and something has to remember that.
 */
export async function recordClarification(input: RecordQuestionInput): Promise<PendingOrder | null> {
  const data = {
    draftItems: input.draftItems as unknown as Prisma.InputJsonValue,
    missing: input.missing,
    lastQuestion: input.question,
    expiresAt: expiresAtFrom(),
  };

  try {
    if (input.existing) {
      return await prisma.pendingOrder.update({
        where: { id: input.existing.id },
        data: { ...data, clarificationCount: { increment: 1 } },
      });
    }

    return await prisma.pendingOrder.create({
      data: {
        ...data,
        businessId: input.businessId,
        customerId: input.customerId,
        sourceMessageId: input.messageId,
        clarificationCount: 1,
      },
    });
  } catch (error: unknown) {
    // The partial unique index fired: another worker opened one first. Not an
    // error worth failing the job over — the question has still been sent, and
    // the other row is the one that will be answered.
    logger.warn(
      { error, businessId: input.businessId, customerId: input.customerId },
      'Could not record a pending order — one is probably already open',
    );
    return null;
  }
}

/**
 * Claims a pending order for conversion, exactly once.
 *
 * The conditional `updateMany` is the same idiom used for outbound send slots:
 * whoever changes the row from AWAITING_REPLY wins, and a loser sees `count` 0
 * and does nothing. Without it, a retried job creates a second real order — and
 * a duplicate order is a duplicate charge against the owner's plan and a
 * duplicate confirmation to the customer.
 */
export async function claimForConversion(pendingOrderId: string): Promise<boolean> {
  const claimed = await prisma.pendingOrder.updateMany({
    where: { id: pendingOrderId, status: 'AWAITING_REPLY', resolvedOrderId: null },
    data: { status: 'RESOLVED' },
  });

  return claimed.count === 1;
}

/** Links the pending order to the order it became, after a successful claim. */
export async function attachResolvedOrder(
  pendingOrderId: string,
  orderId: string,
): Promise<void> {
  await prisma.pendingOrder
    .update({ where: { id: pendingOrderId }, data: { resolvedOrderId: orderId } })
    .catch((error: unknown) => {
      logger.error(
        { error, pendingOrderId, orderId },
        'Order created but not linked to its pending order',
      );
    });
}

/** Releases a claim when conversion failed, so the conversation is not stuck. */
export async function releaseClaim(pendingOrderId: string): Promise<void> {
  await prisma.pendingOrder
    .updateMany({
      where: { id: pendingOrderId, status: 'RESOLVED', resolvedOrderId: null },
      data: { status: 'AWAITING_REPLY' },
    })
    .catch(() => {
      // Worst case it expires on its own.
    });
}

/**
 * Closes a draft the customer has moved on from.
 *
 * Left open, the next unrelated message gets read as an answer to a question
 * about something else entirely.
 */
export async function abandonPendingOrder(pendingOrderId: string): Promise<void> {
  await prisma.pendingOrder
    .updateMany({
      where: { id: pendingOrderId, status: 'AWAITING_REPLY' },
      data: { status: 'ABANDONED' },
    })
    .catch((error: unknown) => {
      logger.warn({ error, pendingOrderId }, 'Failed to abandon a pending order');
    });
}

/** The "awaiting reply" surface: conversations the shop is waiting on. */
export async function listAwaitingReply(businessId: string): Promise<PendingOrder[]> {
  const rows = await prisma.pendingOrder.findMany({
    where: { businessId, status: 'AWAITING_REPLY' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });

  // Filtered rather than expired in place: a read for a dashboard should not
  // start writing, and the next message on that conversation will expire it.
  const now = new Date();
  return rows.filter((row) => !isExpired(row, now));
}
