import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import type { CreatePaymentInput, ListPaymentsQueryInput } from './payments.schema.js';
import { recalculateCustomerTotals } from '../customers/customers.repository.js';

/**
 * What counts as money, as a Prisma filter.
 *
 * The database-side twin of `isAttested` in @flowdesk/shared. The two must agree;
 * if you change one, change the other.
 */
export const ATTESTED_PAYMENT = {
  confidence: { not: 'CLAIMED' },
  voidedAt: null,
} satisfies Prisma.PaymentWhereInput;

export interface PaymentWithCustomer {
  id: string;
  amount: Prisma.Decimal;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  attestedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  screenshotUrl: string | null;
  customer: { id: string; name: string | null; waNumber: string };
  orderId: string | null;
  order?: { id: string; referenceNumber: string; amountPaid: Prisma.Decimal; totalAmount: Prisma.Decimal } | null;
  createdAt: Date;
}

export async function createPayment(
  data: CreatePaymentInput,
  businessId: string,
  loggedById: string | null,
): Promise<PaymentWithCustomer> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        businessId,
        customerId: data.customerId,
        orderId: data.orderId ?? null,
        amount: new Prisma.Decimal(data.amount),
        method: data.method,
        direction: data.direction,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        loggedById,
        confidence: data.attested ? 'SELLER_ATTESTED' : 'CLAIMED',
        attestedBy: data.attested ? loggedById : null,
        attestedAt: data.attested ? new Date() : null,
      },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    // Only attested money moves totals, so they are refreshed only then.
    if (data.attested) {
      if (payment.orderId) {
        await recalculateOrderPaid(payment.orderId, tx);
      }
      await recalculateCustomerTotals(payment.customerId, tx);
    }

    return payment as unknown as PaymentWithCustomer;
  });
}

export async function findPaymentById(id: string, businessId: string): Promise<PaymentWithCustomer | null> {
  const payment = await prisma.payment.findFirst({
    where: { id, businessId },
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payment as PaymentWithCustomer | null;
}

export async function listPayments(
  businessId: string,
  filters: ListPaymentsQueryInput,
): Promise<PaymentWithCustomer[]> {
  const where: Prisma.PaymentWhereInput = { businessId };
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.orderId) where.orderId = filters.orderId;
  if (filters.confidence) where.confidence = filters.confidence;
  if (filters.attested === true) Object.assign(where, ATTESTED_PAYMENT);
  // A live claim awaiting the owner's confirmation — deliberately excludes voided
  // rows. A voided payment is already resolved and needs no action, so it belongs
  // in neither the "attested" nor the "needs checking" bucket. It stays reachable
  // by listing without the `attested` filter.
  if (filters.attested === false) Object.assign(where, { confidence: 'CLAIMED', voidedAt: null });
  if (filters.hasScreenshot) {
    where.screenshotUrl = { not: null };
  }
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(filters.dateFrom);
    if (filters.dateTo) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(filters.dateTo);
  }

  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payments as PaymentWithCustomer[];
}

/**
 * Recomputes an order's `amountPaid` from its attested payments, net of refunds.
 *
 * Materialised rather than accumulated, so attesting, voiding or refunding always
 * lands on the correct figure instead of drifting.
 *
 * The two aggregates run in sequence, not in parallel: an interactive Prisma
 * transaction holds a single connection and concurrent queries on it are not safe.
 */
async function recalculateOrderPaid(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const received = await tx.payment.aggregate({
    where: { orderId, direction: 'IN', ...ATTESTED_PAYMENT },
    _sum: { amount: true },
  });
  const refunded = await tx.payment.aggregate({
    where: { orderId, direction: 'OUT', ...ATTESTED_PAYMENT },
    _sum: { amount: true },
  });

  const net = (received._sum.amount ?? new Prisma.Decimal(0))
    .sub(refunded._sum.amount ?? new Prisma.Decimal(0));

  await tx.order.update({ where: { id: orderId }, data: { amountPaid: net } });
}

/**
 * Records the seller's attestation that the money landed.
 *
 * The update is conditional on the payment still being an unvoided claim, so two
 * simultaneous attestations resolve to exactly one. Returns null when the claim
 * had already been taken — the caller reports that as a conflict, not an error.
 */
export async function attestPaymentWithSideEffects(
  paymentId: string,
  businessId: string,
  attestedBy: string,
): Promise<PaymentWithCustomer | null> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, businessId, confidence: 'CLAIMED', voidedAt: null },
      data: { confidence: 'SELLER_ATTESTED', attestedBy, attestedAt: new Date() },
    });

    if (claimed.count !== 1) return null;

    const updated = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    if (updated.orderId) {
      await recalculateOrderPaid(updated.orderId, tx);
    }
    await recalculateCustomerTotals(updated.customerId, tx);

    return updated as unknown as PaymentWithCustomer;
  });
}

/**
 * Reverses a payment's effect without destroying the record of it.
 *
 * This used to be a hard DELETE. A deleted payment is a destroyed alibi: the one
 * artefact a dispute turns on is what was claimed, by whom, and when. Voiding
 * keeps the row, the reason and the actor, and repairs every total it fed.
 *
 * Returns false when the payment does not exist or was already voided, so a
 * double-submit is a no-op rather than a second reversal.
 */
export async function voidPayment(
  id: string,
  businessId: string,
  voidedBy: string,
  reason: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id, businessId, voidedAt: null },
      data: { voidedAt: new Date(), voidedBy, voidReason: reason },
    });

    if (claimed.count !== 1) return false;

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id },
      select: { customerId: true, orderId: true },
    });

    if (payment.orderId) {
      await recalculateOrderPaid(payment.orderId, tx);
    }
    await recalculateCustomerTotals(payment.customerId, tx);

    return true;
  });
}

export async function getRevenueStats(businessId: string): Promise<{
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  async function netFrom(since: Date | null): Promise<number> {
    const window = since ? { createdAt: { gte: since } } : {};
    const received = await prisma.payment.aggregate({
      where: { businessId, direction: 'IN', ...ATTESTED_PAYMENT, ...window },
      _sum: { amount: true },
    });
    const refunded = await prisma.payment.aggregate({
      where: { businessId, direction: 'OUT', ...ATTESTED_PAYMENT, ...window },
      _sum: { amount: true },
    });
    return Number(received._sum.amount ?? 0) - Number(refunded._sum.amount ?? 0);
  }

  const [totalRevenue, today, thisWeek, thisMonth, byMethodAgg] = await Promise.all([
    netFrom(null),
    netFrom(startOfDay),
    netFrom(startOfWeek),
    netFrom(startOfMonth),
    // Money in, by method. Refunds are excluded rather than netted: the question
    // this answers is which rails customers actually pay on.
    prisma.payment.groupBy({
      by: ['method'],
      where: { businessId, direction: 'IN', ...ATTESTED_PAYMENT },
      _sum: { amount: true },
    }),
  ]);

  const byMethod: Record<string, number> = {};
  for (const row of byMethodAgg) {
    byMethod[row.method] = Number(row._sum.amount ?? 0);
  }

  return { totalRevenue, today, thisWeek, thisMonth, byMethod };
}
