import type { Prisma, WhatsAppTextReceipt } from '@prisma/client';
import { Redis } from 'ioredis';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { normalizeGhanaPhone } from '../utils/phone.js';
import { processMediaReceipt } from './whatsapp-media-receipt.js';
import {
  completeTextReceipt,
  delayTextReceipt,
  failTextReceipt,
  lockDueTextReceipt,
  TEXT_RECEIPT_RETENTION_MS,
} from '../modules/webhook/text-receipts.js';
import {
  createIntentClassificationQueue,
  CLASSIFICATION_EFFECT_WAITING,
  CLASSIFICATION_EFFECT_INTERRUPTED,
  CLASSIFICATION_EFFECT_LEASE_MS,
  type IntentClassificationJobData,
} from '../queues/intent.queue.js';

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 1_000;
const TRANSACTION_OPTIONS = { maxWait: 3_000, timeout: 10_000 };

type EnqueueIntent = (job: IntentClassificationJobData, jobId: string) => Promise<unknown>;
const CLASSIFICATION_CHECK_INTERVAL_MS = 30_000;

function classifierJobId(receipt: { id: string; waMessageId: string }): string {
  return receipt.waMessageId.includes(':') ? `intent-receipt-${receipt.id}` : `intent-${receipt.waMessageId}`;
}

export function openTextReceiptQueue(): { enqueue: EnqueueIntent; ready: () => Promise<void>; close: () => Promise<void> } {
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
    ready: async () => {
      if (connection.status === 'ready') return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Receipt queue connection not ready')), 10_000);
        function finish(error?: Error): void {
          clearTimeout(timer);
          connection.off('ready', finish);
          if (error) reject(error); else resolve();
        }
        connection.once('ready', finish);
      });
    },
    enqueue: async (job: IntentClassificationJobData, jobId: string) => {
      const prior = await queue.getJob(jobId);
      if (prior && await prior.isFailed()) {
        await prior.retry('failed');
        return prior;
      }
      return queue.add('classify-message-intent', job, { jobId, removeOnComplete: { age: 3_600 } });
    },
    close: async () => {
      try {
        await queue.close();
      } finally {
        connection.disconnect();
      }
    },
  };
}

export async function activeOwner(
  tx: Prisma.TransactionClient,
  receipt: WhatsAppTextReceipt,
  now: Date,
): Promise<string | null> {
  if (Math.min(receipt.sentAt.getTime(), receipt.receivedAt.getTime()) < now.getTime() - TEXT_RECEIPT_RETENTION_MS) {
    await failTextReceipt(tx, receipt, now, 'STALE_EVENT');
    return null;
  }
  if (!receipt.businessId) {
    // A later connection is not evidence that it owned the number at delivery.
    await failTextReceipt(tx, receipt, now, 'PHONE_OWNER_UNVERIFIED');
    return null;
  }

  const [owner] = await tx.$queryRaw<Array<{ id: string; active: boolean; waDisplayNumber: string | null }>>`
    SELECT "id", "active", "waDisplayNumber" FROM "businesses"
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
  const [binding] = await tx.$queryRaw<Array<{ id: bigint }>>`
    SELECT id FROM "whatsapp_phone_ownership"
    WHERE "phoneNumberId" = ${receipt.phoneNumberId} AND "businessId" = ${owner.id} AND "endedAt" IS NULL
  `;
  if (receipt.ownershipId !== null && binding?.id !== receipt.ownershipId) {
    await failTextReceipt(tx, receipt, now, 'PHONE_OWNER_CHANGED');
    return null;
  }
  if (receipt.kind === 'ECHO' && owner.waDisplayNumber &&
      normalizeGhanaPhone(owner.waDisplayNumber) !== receipt.echoSender) {
    await failTextReceipt(tx, receipt, now, 'ECHO_SENDER_MISMATCH');
    return null;
  }
  return owner.id;
}

export async function materializeTextMessage(id: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const receipt = await lockDueTextReceipt(tx, id, now);
    if (!receipt) return false;
    if (receipt.messageId) return true;

    const businessId = await activeOwner(tx, receipt, now);
    if (!businessId) return false;
    if (receipt.sender === null || (receipt.kind === 'TEXT' && receipt.body === null)) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_MISSING');
      return false;
    }

    const echo = receipt.kind === 'ECHO';
    const direction = echo ? 'OUTBOUND' : 'INBOUND';
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`whatsapp-message:${receipt.waMessageId}`}, 0))`;

    // Message.waMessageId is globally unique in the existing schema.
    // Reuse compatible legacy rows, and refuse collisions before any write.
    const existing = await tx.message.findUnique({
      where: { waMessageId: receipt.waMessageId },
      select: {
        id: true,
        businessId: true,
        direction: true,
        type: true,
        sentFromApp: true,
        customer: { select: { businessId: true, waNumber: true } },
        textReceipt: { select: { id: true } },
      },
    });
    if (
      existing &&
      (existing.businessId !== businessId ||
        existing.direction !== direction ||
        existing.type !== receipt.messageType ||
        (echo && (!existing.sentFromApp || existing.customer === null)) ||
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
        lastInboundAt: echo ? null : receipt.sentAt,
        lastInteractionAt: receipt.sentAt,
      },
      update: {},
      select: { id: true },
    });
    if (!echo) await tx.customer.updateMany({
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
            direction,
            type: receipt.messageType,
            body: receipt.body,
            createdAt: receipt.sentAt,
            replyToWaId: receipt.replyToWaId,
            mediaType: receipt.mediaMime,
            reactionEmoji: receipt.reactionEmoji,
            reactedToWaId: receipt.reactionTarget,
            ...(echo ? { sentFromApp: true, processed: true, processedAt: now } : {}),
          },
          select: { id: true },
        });

    await tx.whatsAppTextReceipt.update({
      where: { id },
      data: { messageId: message.id },
    });
    if (echo) {
      await completeTextReceipt(tx, receipt, now);
      return false;
    }
    return true;
  }, TRANSACTION_OPTIONS);
}

async function handOffTextMessage(id: string, enqueue: EnqueueIntent, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const receipt = await lockDueTextReceipt(tx, id, now);
    if (!receipt || receipt.kind === 'ECHO' || (receipt.kind === 'MEDIA' && !receipt.mediaArchivedAt)) return;

    const businessId = await activeOwner(tx, receipt, now);
    if (!businessId) return;
    const message = receipt.messageId
      ? await tx.message.findUnique({
          where: { id: receipt.messageId, businessId, waMessageId: receipt.waMessageId, direction: 'INBOUND',
            type: receipt.messageType, customer: { businessId, waNumber: receipt.sender ?? '' } },
          select: { id: true, processed: true, processingError: true },
        })
      : null;
    if (!message) {
      await failTextReceipt(tx, receipt, now, 'MESSAGE_MISSING');
      return;
    }
    if (receipt.kind === 'MEDIA' && !receipt.body?.trim() && !message.processed) {
      await tx.message.update({
        where: { id: message.id, businessId },
        data: { processed: true, processedAt: now, requiresReview: true, processingError: 'MEDIA_ANALYSIS_UNSUPPORTED' },
      });
      await completeTextReceipt(tx, receipt, now);
      return;
    }

    // If the prior dispatch already classified the message, that durable
    // evidence wins even after Redis evicts the job. Otherwise the same job ID
    // deduplicates a retry after Redis accepted it but this transaction rolled back.
    if (!message.processed) {
      try {
        await enqueue(
          { businessId, messageId: message.id, waMessageId: receipt.waMessageId },
          classifierJobId(receipt),
        );
      } catch {
        await delayTextReceipt(tx, receipt, now, 'QUEUE_UNAVAILABLE');
        return;
      }
    }
    if (!message.processed || message.processingError === CLASSIFICATION_EFFECT_WAITING || message.processingError === 'ORDER_EFFECT_WAITING') {
      await tx.whatsAppTextReceipt.update({
        where: { id: receipt.id },
        data: { classificationCheckAt: new Date(now.getTime() + CLASSIFICATION_CHECK_INTERVAL_MS) },
      });
    }
    await completeTextReceipt(tx, receipt, now);
  }, TRANSACTION_OPTIONS);
}

export async function recoverClassificationHandoffs(enqueue: EnqueueIntent, now = new Date()): Promise<number> {
  const due = await prisma.whatsAppTextReceipt.findMany({
    where: { classificationCheckAt: { lte: now } },
    orderBy: [{ classificationCheckAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    take: BATCH_SIZE,
  });
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM whatsapp_text_receipts WHERE id = ${id} AND "classificationCheckAt" <= ${now}
        FOR UPDATE SKIP LOCKED
      `;
      if (!locked) return;
      const receipt = await tx.whatsAppTextReceipt.findUniqueOrThrow({ where: { id } });
      const message = receipt.messageId && receipt.businessId ? await tx.message.findFirst({
        where: { id: receipt.messageId, businessId: receipt.businessId, direction: 'INBOUND',
          waMessageId: receipt.waMessageId, customer: { businessId: receipt.businessId } },
        select: { id: true, businessId: true, processed: true, processingError: true, processedAt: true },
      }) : null;
      if (message?.processingError === CLASSIFICATION_EFFECT_WAITING) {
        const deadline = (message.processedAt?.getTime() ?? 0) + CLASSIFICATION_EFFECT_LEASE_MS;
        if (deadline <= now.getTime()) {
          await tx.message.updateMany({
            where: { id: message.id, businessId: message.businessId, processingError: CLASSIFICATION_EFFECT_WAITING },
            data: { requiresReview: true, processingError: CLASSIFICATION_EFFECT_INTERRUPTED },
          });
        }
        await tx.whatsAppTextReceipt.update({ where: { id }, data: {
          classificationCheckAt: deadline <= now.getTime() ? null : new Date(deadline),
        } });
        return;
      }
      if (!message || (message.processed && message.processingError !== 'ORDER_EFFECT_WAITING')) {
        await tx.whatsAppTextReceipt.update({ where: { id }, data: { classificationCheckAt: null } });
        return;
      }
      const business = await tx.business.findFirst({
        where: { id: message.businessId, active: true, deletedAt: null, deactivatedAt: null, waPhoneNumberId: receipt.phoneNumberId },
        select: { id: true },
      });
      if (!business) {
        await tx.message.updateMany({ where: { id: message.id, businessId: message.businessId,
          OR: [{ processed: false }, { processingError: 'ORDER_EFFECT_WAITING' }] },
          data: { requiresReview: true, processingError: 'CLASSIFICATION_HANDOFF_EXHAUSTED' } });
        await tx.whatsAppTextReceipt.update({ where: { id }, data: { classificationCheckAt: null } });
        return;
      }
      const checks = receipt.classificationChecks + 1;
      if (checks >= 12) {
        await tx.message.updateMany({ where: { id: message.id, businessId: message.businessId,
          OR: [{ processed: false }, { processingError: 'ORDER_EFFECT_WAITING' }] },
          data: { requiresReview: true, processingError: 'CLASSIFICATION_HANDOFF_EXHAUSTED' } });
        await tx.whatsAppTextReceipt.update({ where: { id }, data: { classificationCheckAt: null, classificationChecks: checks } });
        return;
      }
      try {
        await enqueue({ businessId: message.businessId, messageId: message.id, waMessageId: receipt.waMessageId }, classifierJobId(receipt));
      } catch {
        logger.warn({ receiptId: id }, 'Classifier handoff recovery is waiting for Redis');
      }
      await tx.whatsAppTextReceipt.update({ where: { id }, data: {
        classificationChecks: checks,
        classificationCheckAt: new Date(now.getTime() + CLASSIFICATION_CHECK_INTERVAL_MS),
      } });
    }, TRANSACTION_OPTIONS);
  }
  return due.length;
}

export async function dispatchTextReceipts(
  enqueue: EnqueueIntent,
  now = new Date(),
  businessId?: string,
  lane?: 'media' | 'other',
): Promise<number> {
  const due = await prisma.whatsAppTextReceipt.findMany({
    where: {
      nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      ...(businessId ? { businessId } : {}),
      ...(lane ? { kind: lane === 'media' ? 'MEDIA' : { not: 'MEDIA' } } : {}),
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { sentAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true },
    take: lane === 'media' ? 2 : BATCH_SIZE,
  });

  for (const { id, kind } of due) {
    try {
      // Commit the customer and message before the classifier can read them.
      if (await materializeTextMessage(id, now)) {
        if (kind === 'MEDIA' && !(await processMediaReceipt(id, now, activeOwner))) continue;
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

async function expireWaitingReceipts(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - TEXT_RECEIPT_RETENTION_MS);
  await prisma.$executeRaw`
    UPDATE "whatsapp_text_receipts" SET status = 'FAILED', reason = 'STALE_EVENT', "finishedAt" = ${now},
      "nextAttemptAt" = NULL, sender = NULL, body = NULL, "profileName" = NULL, "replyToWaId" = NULL,
      "mediaId" = NULL, "mediaMime" = NULL, "mediaDigest" = NULL, "echoSender" = NULL,
      "reactionEmoji" = NULL, "reactionTarget" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL
    WHERE id IN (SELECT id FROM "whatsapp_text_receipts" WHERE LEAST("sentAt", "receivedAt") < ${cutoff} AND "finishedAt" IS NULL
      AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now}) LIMIT 100 FOR UPDATE SKIP LOCKED)
  `;
}

export function startTextReceiptWorker(): () => Promise<void> {
  const { enqueue, close } = openTextReceiptQueue();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let mediaTimer: NodeJS.Timeout | undefined;
  let mediaInFlight: Promise<void> | undefined;
  let nextPruneAt = 0;

  function tick(): void {
    inFlight = (async () => {
      const now = new Date();
      await dispatchTextReceipts(enqueue, now, undefined, 'other');
      await recoverClassificationHandoffs(enqueue, now);
      if (now.getTime() >= nextPruneAt) {
        await expireWaitingReceipts(now);
        await prisma.$executeRaw`
          DELETE FROM "whatsapp_phone_ownership" WHERE id IN (
            SELECT id FROM "whatsapp_phone_ownership" WHERE "endedAt" < ${new Date(now.getTime() - 2 * TEXT_RECEIPT_RETENTION_MS)}
            ORDER BY "endedAt" LIMIT 100 FOR UPDATE SKIP LOCKED
          )
        `;
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

  function tickMedia(): void {
    mediaInFlight = dispatchTextReceipts(enqueue, new Date(), undefined, 'media')
      .then(() => undefined)
      .catch((error: Error) => logger.warn({ name: error.name }, 'WhatsApp media recovery pass failed'))
      .finally(() => {
        if (!stopped) mediaTimer = setTimeout(tickMedia, POLL_INTERVAL_MS);
      });
  }

  tick();
  tickMedia();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(mediaTimer);
    await Promise.all([inFlight, mediaInFlight]);
    await close();
  };
}
