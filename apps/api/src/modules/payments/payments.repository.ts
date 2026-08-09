import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { CreatePaymentInput, ListPaymentsQueryInput } from './payments.schema.js';
import { recalculateCustomerTotals } from '../customers/customers.repository.js';

export interface PaymentWithCustomer {
  id: string;
  amount: Prisma.Decimal;
  method: string;
  reference: string | null;
  verified: boolean;
  verifiedAt: Date | null;
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
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        loggedById,
        verified: data.verified,
        verifiedBy: data.verified ? loggedById : null,
        verifiedAt: data.verified ? new Date() : null,
      },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    // Only a verified payment moves money, so totals are refreshed only then.
    if (data.verified) {
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
  if (filters.verified !== undefined) where.verified = filters.verified;
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
 * Recomputes an order's `amountPaid` from its verified payments.
 *
 * Like the customer totals, this is a materialised value rather than an
 * accumulator, so verifying, un-verifying or deleting a payment always lands on
 * the correct figure instead of drifting.
 */
async function recalculateOrderPaid(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const paid = await tx.payment.aggregate({
    where: { orderId, verified: true },
    _sum: { amount: true },
  });

  await tx.order.update({
    where: { id: orderId },
    data: { amountPaid: paid._sum.amount ?? new Prisma.Decimal(0) },
  });
}

export async function verifyPaymentWithSideEffects(
  paymentId: string,
  verifiedBy: string,
): Promise<PaymentWithCustomer> {
  const verified = await prisma.$transaction(async (tx) => {
    const updated = await tx.payment.update({
      where: { id: paymentId },
      data: { verified: true, verifiedBy, verifiedAt: new Date() },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    if (updated.orderId) {
      await recalculateOrderPaid(updated.orderId, tx);
    }

    await recalculateCustomerTotals(updated.customerId, tx);

    return updated;
  });

  return verified as unknown as PaymentWithCustomer;
}

/**
 * Deletes a payment and repairs every total it contributed to.
 *
 * Previously this removed the row without reversing its effects, permanently
 * corrupting the customer's balance and the order's paid amount.
 */
export async function deletePayment(id: string, businessId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id, businessId },
      select: { id: true, customerId: true, orderId: true },
    });

    if (!payment) return;

    await tx.payment.delete({ where: { id: payment.id } });

    if (payment.orderId) {
      await recalculateOrderPaid(payment.orderId, tx);
    }

    await recalculateCustomerTotals(payment.customerId, tx);
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

  const [totalAgg, todayAgg, weekAgg, monthAgg, byMethodAgg] = await Promise.all([
    prisma.payment.aggregate({
      where: { businessId, verified: true },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { businessId, verified: true, createdAt: { gte: startOfDay } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { businessId, verified: true, createdAt: { gte: startOfWeek } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { businessId, verified: true, createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { businessId, verified: true },
      _sum: { amount: true },
    }),
  ]);

  const byMethod: Record<string, number> = {};
  for (const row of byMethodAgg) {
    byMethod[row.method] = Number(row._sum.amount ?? 0);
  }

  return {
    totalRevenue: Number(totalAgg._sum.amount ?? 0),
    today: Number(todayAgg._sum.amount ?? 0),
    thisWeek: Number(weekAgg._sum.amount ?? 0),
    thisMonth: Number(monthAgg._sum.amount ?? 0),
    byMethod,
  };
}
