import { OrderStatus } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { notifyOrderStatus } from '../services/notifications/customer-notifications.js';
import { notifyOwnerLowStock } from '../services/notifications/owner-notifications.js';
import { deleteProofObject } from '../services/s3/media.js';
import { isOrderProofKey } from '../modules/shipments/shipments.service.js';

export async function recoverFulfillment(now = new Date()): Promise<void> {
  await prisma.$executeRaw`
    UPDATE fulfillment_tasks SET state = 'FAILED', reason = 'RECOVERY_ATTEMPTS_EXHAUSTED', "nextAttemptAt" = NULL
    WHERE id IN (SELECT id FROM fulfillment_tasks WHERE state = 'PENDING' AND attempts >= 12
      AND "nextAttemptAt" <= ${now} LIMIT 10 FOR UPDATE SKIP LOCKED)
  `;
  const due = await prisma.fulfillmentTask.findMany({
    where: { state: 'PENDING', attempts: { lt: 12 }, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 10,
  });
  await Promise.all(due.map(async (task) => {
    // Reserve a bounded attempt. A process stop leaves the task due again
    // after the lease. Deletion and the outbound event identity are idempotent.
    const claim = new Date(now.getTime() + 30_000);
    if (!(await prisma.fulfillmentTask.updateMany({
      where: { id: task.id, state: 'PENDING', attempts: task.attempts, nextAttemptAt: { lte: now } },
      data: { attempts: { increment: 1 }, nextAttemptAt: claim },
    })).count) return;
    let reason: string | null = null;
    let suppressed = false;
    try {
      if (task.kind === 'OWNER_LOW_STOCK' && task.id === task.subject && task.orderId === null) {
        reason = await notifyOwnerLowStock(task.businessId, task.subject);
        suppressed = reason !== null;
      } else if (task.kind === 'DELETE_PROOF' && task.orderId) {
        if (!isOrderProofKey(task.subject, task.businessId, task.orderId)) throw new Error('Invalid proof identity');
        const live = await prisma.shipment.findFirst({ where: { proofKey: task.subject }, select: { id: true } });
        if (!live) await deleteProofObject(task.subject);
      } else if (task.kind === 'NOTIFY' && task.orderId && Object.hasOwn(OrderStatus, task.subject)) {
        const decision = await notifyOrderStatus(task.orderId, task.subject as OrderStatus, {
          businessId: task.businessId, key: `order-status-${task.orderId}-${task.subject}`,
        });
        if (!decision?.allowed) {
          suppressed = true;
          reason = decision?.reason ?? 'NO_STATUS_TEMPLATE';
        }
      } else {
        reason = 'INVALID_TASK_IDENTITY';
      }
    } catch {
      reason = task.kind === 'DELETE_PROOF' ? 'PROOF_CLEANUP_FAILED' : 'NOTIFICATION_HANDOFF_FAILED';
    }
    const attempts = task.attempts + 1;
    await prisma.fulfillmentTask.updateMany({ where: { id: task.id, state: 'PENDING', attempts, nextAttemptAt: claim }, data: {
      state: suppressed ? 'SUPPRESSED' : reason === null ? 'DONE' : attempts >= 12 ? 'FAILED' : 'PENDING', reason,
      nextAttemptAt: !suppressed && reason !== null && attempts < 12
        ? new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** task.attempts)) : null,
    } });
  }));
}

export function startFulfillmentRecovery(): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout;
  let current: Promise<void>;
  const tick = (): void => {
    current = recoverFulfillment().catch((error: Error) => logger.warn({ name: error.name }, 'Fulfillment recovery pass failed'))
      .finally(() => { if (!stopped) timer = setTimeout(tick, 1_000); });
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await current; };
}
