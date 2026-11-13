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
  try {
    await prisma.$transaction(async (tx) => {
      const request = await tx.paymentRequest.findUnique({ where: { reference }, select: { id: true, businessId: true } });
      const initialization = request ? null : await tx.paystackInitialization.findUnique({
        where: { reference }, select: { businessId: true },
      });
      await tx.paystackReceipt.create({
        data: {
          eventKey, reference, callbackTransactionId, requestId: request?.id ?? null,
          businessId: request?.businessId ?? initialization?.businessId ?? null,
        },
      });
    });
  } catch (error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002' ||
        !(await prisma.paystackReceipt.findUnique({ where: { eventKey }, select: { id: true } }))) {
      throw error;
    }
  }
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
