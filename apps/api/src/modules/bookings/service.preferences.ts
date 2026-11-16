import type { Prisma } from '@prisma/client';

export async function recordServicePreference(tx: Prisma.TransactionClient, businessId: string, customerId: string,
  sourceId: string, body: string | null, at: Date): Promise<void> {
  const preference = body?.trim().match(/^(START|STOP) SERVICE (UPDATES|FOLLOWUPS)$/i);
  if (!preference) return;
  const allowed = preference[1]!.toUpperCase() === 'START';
  const followup = preference[2]!.toUpperCase() === 'FOLLOWUPS';
  if (followup) {
    await tx.customer.updateMany({ where: { id: customerId, businessId, OR: [
      { serviceFollowupAt: null }, { serviceFollowupAt: { lt: at } }, ...(!allowed ? [{ serviceFollowupAt: at, serviceFollowup: true }] : []),
    ] }, data: { serviceFollowup: allowed, serviceFollowupAt: at, serviceFollowupId: sourceId } });
  } else {
    await tx.customer.updateMany({ where: { id: customerId, businessId, OR: [
      { serviceUpdatesAt: null }, { serviceUpdatesAt: { lt: at } }, ...(!allowed ? [{ serviceUpdatesAt: at, serviceUpdates: true }] : []),
    ] }, data: { serviceUpdates: allowed, serviceUpdatesAt: at, serviceUpdatesId: sourceId } });
  }
}
