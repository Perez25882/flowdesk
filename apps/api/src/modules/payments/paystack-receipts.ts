import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PaystackReceipt } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { evidenceText, transactionIdOf } from '../../services/billing/paystack-evidence.js';

export const MAX_PAYSTACK_RECEIPT_ATTEMPTS = 6;
const LEASE_MS = 60_000;
export const MERCHANT_REFERENCE = /^fdpay-[A-Za-z0-9.=-]{1,100}$/;

export async function acceptPaystackReceipt(
  raw: Buffer,
  reference: string,
  data: Record<string, unknown>,
): Promise<void> {
  const eventKey = createHash('sha256').update(raw).digest('hex');
  const callbackTransactionId = data.id === undefined ? null : transactionIdOf(data.id) ?? '';
  // A single autocommitted statement takes one snapshot for owner binding and
  // receipt admission. Concurrent exact duplicates wait for the unique index
  // winner to commit without holding an interactive transaction across queries.
  await prisma.$executeRaw`
    INSERT INTO paystack_receipts (id, "eventKey", reference, "callbackTransactionId", "requestId", "businessId", "updatedAt")
    VALUES (${randomUUID()}, ${eventKey}, ${reference}, ${callbackTransactionId},
      (SELECT id FROM payment_requests WHERE reference = ${reference}),
      COALESCE((SELECT "businessId" FROM payment_requests WHERE reference = ${reference}),
        (SELECT "businessId" FROM paystack_initializations WHERE reference = ${reference})), now())
    ON CONFLICT ("eventKey") DO NOTHING
  `;
}

export async function claimPaystackReceipt(businessId?: string): Promise<PaystackReceipt | null> {
  const scope = businessId === undefined ? Prisma.empty : Prisma.sql`AND "businessId" = ${businessId}`;
  return prisma.$transaction(async (tx) => {
    const [candidate] = await tx.$queryRaw<Array<{ id: string; attempts: number }>>`
      SELECT id, attempts FROM paystack_receipts
      WHERE (
        state = 'PENDING' OR (state = 'WAITING' AND "nextAttemptAt" <= now())
        OR (state = 'PROCESSING' AND "leaseUntil" <= now())
      ) ${scope}
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!candidate) return null;
    const now = new Date();
    if (candidate.attempts >= MAX_PAYSTACK_RECEIPT_ATTEMPTS) {
      return tx.paystackReceipt.update({
        where: { id: candidate.id },
        data: { state: 'REVIEW', reason: 'LEASE_RETRY_LIMIT', completedAt: now, leaseToken: null, leaseUntil: null },
      });
    }
    return tx.paystackReceipt.update({
      where: { id: candidate.id },
      data: {
        state: 'PROCESSING', attempts: { increment: 1 }, leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + LEASE_MS), nextAttemptAt: null,
      },
    });
  });
}

export function receiptLease(receipt: PaystackReceipt): Prisma.PaystackReceiptWhereInput {
  return { id: receipt.id, state: 'PROCESSING', leaseToken: receipt.leaseToken, leaseUntil: { gt: new Date() } };
}

export async function waitForPaystackRetry(receipt: PaystackReceipt, reason: string): Promise<void> {
  const exhausted = receipt.attempts >= MAX_PAYSTACK_RECEIPT_ATTEMPTS;
  const backoff = Math.min(30_000 * 2 ** (receipt.attempts - 1), 900_000);
  await prisma.paystackReceipt.updateMany({
    where: receiptLease(receipt),
    data: {
      state: exhausted ? 'REVIEW' : 'WAITING', reason,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + backoff),
      completedAt: exhausted ? new Date() : null,
      leaseToken: null, leaseUntil: null,
    },
  });
}

export function merchantReferenceOf(value: unknown): string | null {
  const reference = evidenceText(value);
  return reference && MERCHANT_REFERENCE.test(reference) ? reference : null;
}
