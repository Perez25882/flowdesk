import { randomUUID } from 'node:crypto';
import { type PaystackSettlement } from '@prisma/client';
import { prisma } from '../config/database.js';
import { redis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { sendPaymentReceipt } from '../services/notifications/receipts.js';
import { drainPaystackReceipts } from '../modules/payments/paystack-settlement.js';

const MAX_NOTIFICATION_ATTEMPTS = 5;

async function claimNotification(): Promise<PaystackSettlement | null> {
  return prisma.$transaction(async (tx) => {
    const [candidate] = await tx.$queryRaw<Array<{ id: string; attempts: number }>>`
      SELECT id, "notificationAttempts" AS attempts FROM paystack_settlements
      WHERE ("notificationState" = 'PENDING' AND "notificationNextAt" <= now())
        OR ("notificationState" = 'SENDING' AND "notificationLeaseUntil" <= now())
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!candidate) return null;
    if (candidate.attempts >= MAX_NOTIFICATION_ATTEMPTS) {
      return tx.paystackSettlement.update({
        where: { id: candidate.id },
        data: { notificationState: 'REVIEW', notificationLeaseToken: null, notificationLeaseUntil: null, notificationNextAt: null },
      });
    }
    return tx.paystackSettlement.update({
      where: { id: candidate.id },
      data: {
        notificationState: 'SENDING', notificationAttempts: { increment: 1 },
        notificationLeaseToken: randomUUID(), notificationLeaseUntil: new Date(Date.now() + 60_000),
      },
    });
  });
}

export async function drainPaystackNotifications(): Promise<void> {
  if (redis.status !== 'ready') return;
  for (let i = 0; i < 5; i += 1) {
    const job = await claimNotification();
    if (!job) return;
    if (job.notificationState !== 'SENDING') continue;
    const fence = {
      id: job.id, notificationState: 'SENDING' as const, notificationLeaseToken: job.notificationLeaseToken,
    };
    let state: 'HANDED_OFF' | 'SUPPRESSED' | 'PENDING' | 'REVIEW';
    try {
      state = await sendPaymentReceipt(job.paymentId);
    } catch (error: unknown) {
      logger.warn({ settlementId: job.id, errorType: error instanceof Error ? error.name : 'Unknown' }, 'Paystack receipt handoff failed');
      state = job.notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS ? 'REVIEW' : 'PENDING';
    }
    await prisma.paystackSettlement.updateMany({
      where: { ...fence, notificationLeaseUntil: { gt: new Date() } },
      data: {
        notificationState: state, notificationLeaseToken: null, notificationLeaseUntil: null,
        notificationNextAt: state === 'PENDING' ? new Date(Date.now() + 60_000 * job.notificationAttempts) : null,
      },
    });
  }
}

async function flagStaleInitializations(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE paystack_initializations SET state = 'REVIEW', reason = 'INITIALIZATION_INTERRUPTED', "updatedAt" = now()
    WHERE reference IN (
      SELECT reference FROM paystack_initializations WHERE state = 'INITIALIZING'
        AND "createdAt" < now() - interval '1 minute'
      ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED
    )
  `;
}

function poll(task: () => Promise<unknown>, interval: number, operation: string): () => Promise<void> {
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active) return;
    active = task().catch((error: unknown) => {
      logger.warn({ operation, errorType: error instanceof Error ? error.name : 'Unknown' }, 'Paystack polling will retry');
    }).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, interval);
  tick();
  return async () => { clearInterval(timer); await active; };
}

export function startPaystackSettlementWorker(): () => Promise<void> {
  const stopReceipts = poll(drainPaystackReceipts, 3_000, 'receipts');
  const stopNotifications = poll(drainPaystackNotifications, 5_000, 'notifications');
  const stopInitializations = poll(flagStaleInitializations, 30_000, 'initializations');
  return async () => { await Promise.all([stopReceipts(), stopNotifications(), stopInitializations()]); };
}
