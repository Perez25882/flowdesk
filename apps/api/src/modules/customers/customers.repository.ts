import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { UpdateCustomerInput, ListCustomersQueryInput } from './customers.schema.js';

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
    verified: boolean;
    createdAt: Date;
  }>;
}> {
  const customer = await prisma.customer.findFirst({
    where: { id, businessId },
    include: {
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, referenceNumber: true, status: true, totalAmount: true, createdAt: true },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, amount: true, method: true, verified: true, createdAt: true },
      },
    },
  });

  if (!customer) throw new Error('Customer not found');

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
