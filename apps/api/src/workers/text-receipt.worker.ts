import type { Prisma, WhatsAppTextReceipt } from '@prisma/client';
import { Redis } from 'ioredis';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  completeTextReceipt,
  delayTextReceipt,
  failTextReceipt,
  lockDueTextReceipt,
  TEXT_RECEIPT_RETENTION_MS,
} from '../modules/webhook/text-receipts.js';
import {
  createIntentClassificationQueue,
  type IntentClassificationJobData,
} from '../queues/intent.queue.js';

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 1_000;
const TRANSACTION_OPTIONS = { maxWait: 3_000, timeout: 10_000 };

type EnqueueIntent = (job: IntentClassificationJobData, jobId: string) => Promise<unknown>;

export function openTextReceiptQueue(): { enqueue: EnqueueIntent; close: () => Promise<void> } {
  // A producer must fail in bounded time while holding a receipt row lock.
  // The ordinary worker connections buffer commands through Redis outages.
  const connection = new Redis(env.REDIS_URL, {
    connectionName: 'flowdesk-text-receipts',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    connectTimeout: 2_000,
    retryStrategy: () => 1_000,
  });
  const queue = createIntentClassificationQueue({
    // @ts-expect-error ioredis and BullMQ use different ioredis patch versions
    connection,
    skipWaitingForReady: true,
    skipVersionCheck: true,
  });
  queue.on('error', (error) => {
    logger.warn({ name: error.name }, 'Text receipt classifier queue unavailable');
  });

  return {
    enqueue: (job: IntentClassificationJobData, jobId: string) =>
      queue.add('classify-message-intent', job, { jobId, removeOnComplete: { age: 3_600 } }),
    close: async () => {
      try {
        await queue.close();
      } finally {
        connection.disconnect();
      }
    },
  };
}

async function activeOwner(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
): Promise<string | null> {
  if (!receipt.businessId) {
    // A later connection is not evidence that it owned the number at delivery.
    await failTextReceipt(tx, receipt, now, 'PHONE_OWNER_UNVERIFIED');
    return null;
  }

  const [owner] = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT "id", "active" FROM "businesses"
    WHERE "waPhoneNumberId" = ${receipt.phoneNumberId} AND "deletedAt" IS NULL
    FOR SHARE
  `;
  if (owner && owner.id !== receipt.businessId) {
    await failTextReceipt(tx, receipt, now, 'PHONE_OWNER_CHANGED');
    return null;
  }
  if (!owner?.active) {
    await delayTextReceipt(tx, receipt, now, 'PHONE_NOT_ACTIVE');
    return null;
  }
  return owner.id;
}

async function materializeTextMessage(id: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const receipt = await lockDueTextReceipt(tx, id, now);
    if (!receipt) return false;
    if (receipt.messageId) return true;

    const businessId = await activeOwner(tx, receipt, now);
    if (!businessId) return false;
    if (receipt.sender === null || receipt.body === null) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_MISSING');
      return false;
    }

    // Message.waMessageId is globally unique in the existing schema.
    // Reuse compatible legacy rows, and refuse collisions before any write.
    const existing = await tx.message.findUnique({
      where: { waMessageId: receipt.waMessageId },
      select: {
        id: true,
        businessId: true,
        direction: true,
        type: true,
        customer: { select: { businessId: true, waNumber: true } },
        textReceipt: { select: { id: true } },
      },
    });
    if (
      existing &&
      (existing.businessId !== businessId ||
        existing.direction !== 'INBOUND' ||
        existing.type !== 'TEXT' ||
        (existing.customer !== null &&
          (existing.customer.businessId !== businessId ||
            existing.customer.waNumber !== receipt.sender)) ||
        existing.textReceipt !== null)
    ) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_ID_COLLISION');
      return false;
    }

    const customer = await tx.customer.upsert({
      where: { businessId_waNumber: { businessId, waNumber: receipt.sender } },
      create: {
        businessId,
        waNumber: receipt.sender,
        name: receipt.profileName,
        lastInboundAt: receipt.sentAt,
        lastInteractionAt: receipt.sentAt,
      },
      update: {},
      select: { id: true },
    });
    await tx.customer.updateMany({
      where: {
        id: customer.id,
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: receipt.sentAt } }],
      },
      data: {
        lastInboundAt: receipt.sentAt,
        ...(receipt.profileName === null ? {} : { name: receipt.profileName }),
      },
    });
    await tx.customer.updateMany({
      where: {
        id: customer.id,
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: receipt.sentAt } }],
      },
      data: { lastInteractionAt: receipt.sentAt },
    });

    const message = existing
      ? await tx.message.update({
          where: { id: existing.id, businessId },
          data: { customerId: customer.id },
          select: { id: true },
        })
      : await tx.message.create({
          data: {
            businessId,
            customerId: customer.id,
            waMessageId: receipt.waMessageId,
            direction: 'INBOUND',
            type: 'TEXT',
            body: receipt.body,
            createdAt: receipt.sentAt,
            replyToWaId: receipt.replyToWaId,
          },
          select: { id: true },
        });

    await tx.whatsAppTextReceipt.update({
      where: { id },
      data: { messageId: message.id },
    });
    return true;
  }, TRANSACTION_OPTIONS);
}

async function handOffTextMessage(id: string, enqueue: EnqueueIntent, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const receipt = await lockDueTextReceipt(tx, id, now);
    if (!receipt) return;

    const businessId = await activeOwner(tx, receipt, now);
    if (!businessId) return;
    const message = receipt.messageId
      ? await tx.message.findUnique({
          where: { id: receipt.messageId, businessId },
          select: { id: true, processed: true },
        })
      : null;
    if (!message) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_MISSING');
      return;
    }

    // If the prior dispatch already classified the message, that durable
    // evidence wins even after Redis evicts the job. Otherwise the same job ID
    // deduplicates a retry after Redis accepted it but this transaction rolled back.
    if (!message.processed) {
      const jobId = receipt.waMessageId.includes(':')
        ? `intent-receipt-${receipt.id}`
        : `intent-${receipt.waMessageId}`;
      try {
        await enqueue(
          { businessId, messageId: message.id, waMessageId: receipt.waMessageId },
          jobId,
        );
      } catch {
        await delayTextReceipt(tx, receipt, now, 'QUEUE_UNAVAILABLE');
        return;
      }
    }
    await completeTextReceipt(tx, receipt, now);
  }, TRANSACTION_OPTIONS);
}

export async function dispatchTextReceipts(
  enqueue: EnqueueIntent,
  now = new Date(),
): Promise<number> {
  const due = await prisma.whatsAppTextReceipt.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    take: BATCH_SIZE,
  });

  for (const { id } of due) {
    try {
      // Commit the customer and message before the classifier can read them.
      if (await materializeTextMessage(id, now)) {
        await handOffTextMessage(id, enqueue, now);
      }
    } catch (error) {
      logger.warn({ receiptId: id, name: (error as Error).name }, 'Text receipt processing failed');
      await prisma.$transaction(async (tx) => {
        const receipt = await lockDueTextReceipt(tx, id, now);
        if (receipt) await delayTextReceipt(tx, receipt, now, 'STORAGE_ERROR');
      }, TRANSACTION_OPTIONS);
    }
  }
  return due.length;
}

async function pruneTextReceipts(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TEXT_RECEIPT_RETENTION_MS);
  return prisma.$executeRaw`
    DELETE FROM "whatsapp_text_receipts" WHERE "id" IN (
      SELECT "id" FROM "whatsapp_text_receipts"
      WHERE "finishedAt" < ${cutoff}
      ORDER BY "finishedAt" LIMIT 100 FOR UPDATE SKIP LOCKED
    )
  `;
}

export function startTextReceiptWorker(): () => Promise<void> {
  const { enqueue, close } = openTextReceiptQueue();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let nextPruneAt = 0;

  function tick(): void {
    inFlight = (async () => {
      const now = new Date();
      await dispatchTextReceipts(enqueue, now);
      if (now.getTime() >= nextPruneAt) {
        const deleted = await pruneTextReceipts(now);
        nextPruneAt = deleted === 100 ? now.getTime() : now.getTime() + 60_000;
      }
    })()
      .catch((error: Error) =>
        logger.warn({ name: error.name }, 'Text receipt recovery pass failed'),
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
      });
  }

  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
    await close();
  };
}
