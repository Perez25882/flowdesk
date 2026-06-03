import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { CreatePaymentInput, ListPaymentsQueryInput } from './payments.schema.js';

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
  const payment = await prisma.payment.create({
    data: {
      businessId,
      customerId: data.customerId,
      orderId: data.orderId ?? null,
      amount: new Prisma.Decimal(data.amount),
      method: data.method,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      loggedById,
    },
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payment as PaymentWithCustomer;
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

export async function verifyPayment(
  id: string,
  businessId: string,
  verifiedBy: string,
): Promise<PaymentWithCustomer> {
  const payment = await prisma.payment.update({
    where: { id, businessId },
    data: { verified: true, verifiedBy, verifiedAt: new Date() },
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payment as PaymentWithCustomer;
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
      await tx.order.update({
        where: { id: updated.orderId },
        data: {
          amountPaid: { increment: updated.amount },
        },
      });
    }

    await tx.customer.update({
      where: { id: updated.customerId },
      data: {
        totalSpend: { increment: updated.amount },
        outstandingBalance: { decrement: updated.amount },
      },
    });

    return updated;
  });

  return verified as unknown as PaymentWithCustomer;
}

export async function deletePayment(id: string, businessId: string): Promise<void> {
  await prisma.payment.deleteMany({
    where: { id, businessId },
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
