import { prisma } from '../src/config/database.js';
import { redis, redisSubscriber, rateLimitRedis, sseSubscriber } from '../src/config/redis.js';
import { drainPaystackReceipts } from '../src/modules/payments/paystack-settlement.js';

async function main(): Promise<void> {
  const [action, businessId, receiptId] = process.argv.slice(2);
  if (!businessId || !['list', 'drain', 'retry'].includes(action ?? '') || (action === 'retry' && !receiptId)) {
    throw new Error('Usage: tsx scripts/reconcile-paystack.ts <list|drain|retry> <businessId> [receiptId]');
  }
  if (action === 'drain') {
    console.log(JSON.stringify({ processed: await drainPaystackReceipts(businessId) }));
    return;
  }
  if (action === 'retry') {
    const result = await prisma.paystackReceipt.updateMany({
      where: { businessId, id: receiptId!, state: 'WAITING' },
      data: { nextAttemptAt: new Date() },
    });
    if (!result.count) throw new Error('No waiting receipt in this business matched the ID');
    console.log(JSON.stringify({ scheduled: result.count }));
    return;
  }
  const [receipts, initializations, notifications] = await Promise.all([
    prisma.paystackReceipt.findMany({
      where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100,
      select: {
        id: true, reference: true, requestId: true, state: true, reason: true, evidence: true,
        attempts: true, nextAttemptAt: true, createdAt: true, completedAt: true,
      },
    }),
    prisma.paystackInitialization.findMany({
      where: { businessId, state: { in: ['INITIALIZING', 'REVIEW'] } }, orderBy: { createdAt: 'desc' }, take: 100,
    }),
    prisma.paystackSettlement.findMany({
      where: { request: { businessId }, notificationState: { in: ['PENDING', 'SENDING', 'REVIEW'] } },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, paymentId: true, notificationState: true, notificationAttempts: true, notificationNextAt: true },
    }),
  ]);
  console.log(JSON.stringify({ receipts, initializations, notifications }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Paystack reconciliation failed');
  process.exitCode = 1;
}).finally(async () => {
  for (const client of [redis, redisSubscriber, rateLimitRedis, sseSubscriber]) client.disconnect();
  await prisma.$disconnect();
});
