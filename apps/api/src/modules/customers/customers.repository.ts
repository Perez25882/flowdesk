import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import { NotFoundError } from '../../utils/errors.js';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import type { UpdateCustomerInput, ListCustomersQueryInput } from './customers.schema.js';

/**
 * Order statuses that represent a real financial obligation. A PENDING order is
 * not yet owed — the owner has not accepted it — and a CANCELLED one never was.
 *
 * DISPATCHED belongs here for the obvious reason: goods that have left the shop
 * are the most owed they will ever be. It was missing when the status was
 * added, so sending an order out quietly erased it from what the customer owed.
 */
const BILLABLE_STATUSES = ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'FULFILLED'] as const;

/**
 * Recomputes a customer's denormalised totals from the underlying orders and
 * payments, and writes them back.
 *
 * These columns are a materialised cache, never an accumulator. Incrementing
 * them in place is what allowed balances to drift permanently negative: a
 * deleted or re-verified payment had no compensating adjustment. Recomputing
 * from source makes every write self-healing and idempotent.
 *
 * Call this after ANY change to an order's status or a payment's attestation or
 * voiding.
 */
export async function recalculateCustomerTotals(
  customerId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;

  // The where-clause below is written out longhand rather than importing
  // ATTESTED_PAYMENT from payments.repository.ts: that file already imports
  // recalculateCustomerTotals from this one, so importing back would close a
  // circular dependency. Keep the two in step by hand.
  const [billable, received, refunded, orderCount, firstOrder] = await Promise.all([
    db.order.aggregate({
      where: { customerId, deletedAt: null, status: { in: [...BILLABLE_STATUSES] } },
      _sum: { totalAmount: true },
    }),
    db.payment.aggregate({
      where: { customerId, direction: 'IN', confidence: { not: 'CLAIMED' }, voidedAt: null },
      _sum: { amount: true },
    }),
    db.payment.aggregate({
      where: { customerId, direction: 'OUT', confidence: { not: 'CLAIMED' }, voidedAt: null },
      _sum: { amount: true },
    }),
    db.order.count({ where: { customerId, deletedAt: null } }),
    db.order.findFirst({
      where: { customerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  const owed = billable._sum.totalAmount ?? new Prisma.Decimal(0);
  const paid = (received._sum.amount ?? new Prisma.Decimal(0))
    .sub(refunded._sum.amount ?? new Prisma.Decimal(0));

  await db.customer.update({
    where: { id: customerId },
    data: {
      // Negative balances (customer in credit) are preserved rather than
      // clamped — an overpayment is real information the owner needs.
      outstandingBalance: owed.sub(paid),
      totalSpend: paid,
      totalOrders: orderCount,
      firstOrderAt: firstOrder?.createdAt ?? null,
    },
  });
}

export interface CustomerWithStats {
  id: string;
  waNumber: string;
  name: string | null;
  outstandingBalance: Prisma.Decimal;
  totalSpend: Prisma.Decimal;
  totalOrders: number;
  tags: string[];
  blacklisted: boolean;
  vip: boolean;
  lastInteractionAt: Date | null;
  notes: string | null;
  createdAt: Date;
}

export async function listCustomers(
  businessId: string,
  filters: ListCustomersQueryInput,
): Promise<CustomerWithStats[]> {
  const where: Prisma.CustomerWhereInput = { businessId, deletedAt: null };
  if (filters.hasBalance) where.outstandingBalance = { gt: new Prisma.Decimal(0) };
  if (filters.tag) where.tags = { has: filters.tag };
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { waNumber: { contains: filters.search } },
    ];
  }

  const customers = await prisma.customer.findMany({
    where,
    orderBy: { lastInteractionAt: 'desc' },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
  });
  return customers as CustomerWithStats[];
}

export async function findCustomerById(
  id: string,
  businessId: string,
): Promise<CustomerWithStats | null> {
  const customer = await prisma.customer.findFirst({
    where: { id, businessId },
  });
  return customer as CustomerWithStats | null;
}

export async function getCustomerWithHistory(
  id: string,
  businessId: string,
): Promise<{
  customer: CustomerWithStats;
  orders: Array<{
    id: string;
    referenceNumber: string;
    status: string;
    totalAmount: Prisma.Decimal;
    createdAt: Date;
  }>;
  payments: Array<{
    id: string;
    amount: Prisma.Decimal;
    method: string;
    direction: PaymentDirection;
    confidence: PaymentConfidence;
    voidedAt: Date | null;
    createdAt: Date;
  }>;
}> {
  const customer = await prisma.customer.findFirst({
    where: { id, businessId },
    include: {
      // Nested reads are scoped to this business too, as defence in depth: even
      // if a foreign order ever referenced this customer, it would not surface
      // on the customer's own history screen.
      orders: {
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, referenceNumber: true, status: true, totalAmount: true, createdAt: true },
      },
      payments: {
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          amount: true,
          method: true,
          direction: true,
          confidence: true,
          voidedAt: true,
          createdAt: true,
        },
      },
    },
  });

  // NotFoundError so the global handler returns 404 — a bare Error fell through
  // to a 500 for any id belonging to another tenant.
  if (!customer) throw new NotFoundError('Customer not found');

  return {
    customer: customer as CustomerWithStats,
    orders: customer.orders,
    payments: customer.payments,
  };
}

export async function updateCustomer(
  id: string,
  businessId: string,
  data: UpdateCustomerInput,
): Promise<CustomerWithStats> {
  const updateData: Prisma.CustomerUpdateInput = {};
  if (data.name !== undefined) updateData.name = data.name || null;
  if (data.tags !== undefined) updateData.tags = data.tags;
  if (data.notes !== undefined) updateData.notes = data.notes || null;
  if (data.blacklisted !== undefined) updateData.blacklisted = data.blacklisted;
  if (data.vip !== undefined) updateData.vip = data.vip;

  const customer = await prisma.customer.update({
    where: { id, businessId },
    data: updateData,
  });
  return customer as CustomerWithStats;
}

export async function findCustomerByPhone(
  businessId: string,
  waNumber: string,
): Promise<CustomerWithStats | null> {
  const customer = await prisma.customer.findFirst({
    where: { businessId, waNumber, deletedAt: null },
  });
  return customer as CustomerWithStats | null;
}

export async function upsertCustomerByPhone(
  businessId: string,
  waNumber: string,
  displayName: string | null,
): Promise<CustomerWithStats> {
  // Idempotent: lookup first (unique on [businessId, waNumber]), then create.
  // The unique constraint combined with the deletedAt filter rules out races because
  // we'd hit P2002 if a parallel transaction beat us to insert — we then re-read.
  const existing = await prisma.customer.findFirst({
    where: { businessId, waNumber, deletedAt: null },
  });
  if (existing) {
    if (displayName && !existing.name) {
      const updated = await prisma.customer.update({
        where: { id: existing.id },
        data: { name: displayName },
      });
      return updated as CustomerWithStats;
    }
    return existing as CustomerWithStats;
  }

  try {
    const created = await prisma.customer.create({
      data: {
        businessId,
        waNumber,
        ...(displayName ? { name: displayName } : {}),
      },
    });
    return created as CustomerWithStats;
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const racer = await prisma.customer.findFirst({
        where: { businessId, waNumber, deletedAt: null },
      });
      if (racer) return racer as CustomerWithStats;
    }
    throw e;
  }
}
