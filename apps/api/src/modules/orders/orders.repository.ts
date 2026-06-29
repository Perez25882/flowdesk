import { Prisma, type OrderStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../utils/errors.js';

export interface CreateOrderItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateOrderInput {
  businessId: string;
  customerId: string;
  referenceNumber: string;
  rawMessage: string;
  isManual: boolean;
  items: CreateOrderItemInput[];
  notes?: string;
}

export interface OrderWithRelations {
  id: string;
  businessId: string;
  customerId: string;
  referenceNumber: string;
  rawMessage: string;
  isManual: boolean;
  status: OrderStatus;
  totalAmount: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  assignedStaffId: string | null;
  stockDeducted: boolean;
  confirmedAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    productId: string | null;
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    subtotal: Prisma.Decimal;
    matched: boolean;
    matchConfidence: number | null;
  }>;
  customer: {
    id: string;
    waNumber: string;
    name: string | null;
  };
  assignedTo: {
    id: string;
    name: string;
  } | null;
  payments: Array<{
    id: string;
    amount: Prisma.Decimal;
    method: string;
    verified: boolean;
  }>;
  statusHistory: Array<{
    id: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    changedBy: string | null;
    note: string | null;
    createdAt: Date;
  }>;
}

export interface OrderFilters {
  status?: OrderStatus | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  staffId?: string | undefined;
  search?: string | undefined;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface OrderStats {
  totalOrders: number;
  byStatus: Record<string, number>;
  totalRevenue: number;
  totalPaid: number;
  pendingAmount: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export type PrismaTransaction = Prisma.TransactionClient;

function buildWhereClause(businessId: string, filters: OrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {
    businessId,
    deletedAt: null,
  };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) {
      where.createdAt.gte = filters.dateFrom;
    }
    if (filters.dateTo) {
      where.createdAt.lte = filters.dateTo;
    }
  }

  if (filters.staffId) {
    where.assignedStaffId = filters.staffId;
  }

  if (filters.search) {
    where.OR = [
      { referenceNumber: { contains: filters.search, mode: 'insensitive' } },
      { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
      { customer: { waNumber: { contains: filters.search, mode: 'insensitive' } } },
    ];
  }

  return where;
}

export async function createOrder(
  data: CreateOrderInput,
  tx?: PrismaTransaction,
): Promise<OrderWithRelations> {
  const db = tx ?? prisma;

  const totalAmount = data.items.reduce((sum, item) => {
    return sum + item.quantity * item.unitPrice;
  }, 0);

  const order = await db.order.create({
    data: {
      businessId: data.businessId,
      customerId: data.customerId,
      referenceNumber: data.referenceNumber,
      rawMessage: data.rawMessage,
      isManual: data.isManual,
      totalAmount: new Prisma.Decimal(totalAmount),
      notes: data.notes ?? null,
      items: {
        create: data.items.map((item) => ({
          productId: item.productId ?? null,
          description: item.description,
          quantity: new Prisma.Decimal(item.quantity),
          unitPrice: new Prisma.Decimal(item.unitPrice),
          subtotal: new Prisma.Decimal(item.quantity * item.unitPrice),
          matched: !!item.productId,
        })),
      },
      statusHistory: {
        create: {
          toStatus: 'PENDING',
          changedBy: 'system',
          note: data.isManual ? 'Manual order created' : 'Order created from customer message',
        },
      },
    },
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: true,
    },
  });

  return order as unknown as OrderWithRelations;
}

export async function findOrderById(
  id: string,
  businessId: string,
): Promise<OrderWithRelations | null> {
  const order = await prisma.order.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: { orderBy: { createdAt: 'desc' } },
    },
  });

  return order as unknown as OrderWithRelations | null;
}

export async function findOrderByReference(
  ref: string,
  businessId: string,
): Promise<OrderWithRelations | null> {
  const order = await prisma.order.findFirst({
    where: {
      referenceNumber: ref,
      businessId,
      deletedAt: null,
    },
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: { orderBy: { createdAt: 'desc' } },
    },
  });

  return order as unknown as OrderWithRelations | null;
}

export async function updateOrderStatus(
  id: string,
  status: OrderStatus,
  changedBy: string | null,
  note: string | null,
  tx?: PrismaTransaction,
): Promise<OrderWithRelations> {
  const db = tx ?? prisma;

  const existing = await db.order.findFirst({
    where: { id, deletedAt: null },
    select: { status: true },
  });

  if (!existing) {
    throw new NotFoundError('Order not found');
  }

  const updateData: Prisma.OrderUpdateInput = {
    status,
  };

  if (status === 'CONFIRMED') {
    updateData.confirmedAt = new Date();
  } else if (status === 'FULFILLED') {
    updateData.fulfilledAt = new Date();
  } else if (status === 'CANCELLED') {
    updateData.cancelledAt = new Date();
  }

  const order = await db.order.update({
    where: { id },
    data: updateData,
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: true,
    },
  });

  await db.orderStatusHistory.create({
    data: {
      orderId: id,
      fromStatus: existing.status,
      toStatus: status,
      changedBy,
      note,
    },
  });

  return order as unknown as OrderWithRelations;
}

export async function listOrders(
  businessId: string,
  filters: OrderFilters,
  pagination: PaginationParams,
): Promise<{ orders: OrderWithRelations[]; total: number }> {
  const where = buildWhereClause(businessId, filters);
  const skip = (pagination.page - 1) * pagination.pageSize;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: pagination.pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        items: true,
        customer: { select: { id: true, waNumber: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
        payments: { select: { id: true, amount: true, method: true, verified: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders as unknown as OrderWithRelations[],
    total,
  };
}

export async function assignOrderToStaff(
  orderId: string,
  staffId: string,
  businessId: string,
): Promise<OrderWithRelations> {
  const order = await prisma.order.update({
    where: { id: orderId, businessId, deletedAt: null },
    data: {
      assignedStaffId: staffId,
    },
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: true,
    },
  });

  return order as unknown as OrderWithRelations;
}

const REFERENCE_PREFIX = 'FD-';
const REFERENCE_PAD_LENGTH = 5;

function padReference(num: number): string {
  return `${REFERENCE_PREFIX}${String(num).padStart(REFERENCE_PAD_LENGTH, '0')}`;
}

const REDIS_REF_KEY_PREFIX = 'flowdesk:order-ref:';

async function getNextReferenceFromRedis(businessId: string): Promise<number | null> {
  try {
    const nextNum = await redis.incr(`${REDIS_REF_KEY_PREFIX}${businessId}`);
    return nextNum;
  } catch (error: unknown) {
    logger.warn({ error, businessId }, 'Redis INCR failed for order reference, falling back to DB');
    return null;
  }
}

async function getNextReferenceFromDb(
  businessId: string,
  tx?: PrismaTransaction,
): Promise<number> {
  const db = tx ?? prisma;

  const latestOrder = await db.order.findFirst({
    where: {
      businessId,
      deletedAt: null,
    },
    orderBy: {
      referenceNumber: 'desc',
    },
    select: {
      referenceNumber: true,
    },
  });

  let nextNum = 1;

  if (latestOrder?.referenceNumber && latestOrder.referenceNumber.startsWith(REFERENCE_PREFIX)) {
    const numericPart = latestOrder.referenceNumber.slice(REFERENCE_PREFIX.length);
    const parsed = Number.parseInt(numericPart, 10);
    if (!Number.isNaN(parsed)) {
      nextNum = parsed + 1;
    }
  }

  return nextNum;
}

export async function generateOrderReference(
  businessId: string,
  tx?: PrismaTransaction,
): Promise<string> {
  const redisNum = await getNextReferenceFromRedis(businessId);

  if (redisNum !== null) {
    return padReference(redisNum);
  }

  const dbNum = await getNextReferenceFromDb(businessId, tx);
  return padReference(dbNum);
}

export async function findOrdersByStatus(
  businessId: string,
  status: OrderStatus,
  staffId?: string,
): Promise<OrderWithRelations[]> {
  const orders = await prisma.order.findMany({
    where: {
      businessId,
      status,
      deletedAt: null,
      ...(staffId ? { assignedStaffId: staffId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      items: true,
      customer: { select: { id: true, waNumber: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, method: true, verified: true } },
      statusHistory: { orderBy: { createdAt: 'desc' }, take: 3 },
    },
  });

  return orders as unknown as OrderWithRelations[];
}

export async function getOrderStats(
  businessId: string,
  dateRange: DateRange,
): Promise<OrderStats> {
  const where: Prisma.OrderWhereInput = {
    businessId,
    deletedAt: null,
    createdAt: {
      gte: dateRange.start,
      lte: dateRange.end,
    },
  };

  const [orders, totalPaidAgg] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        status: true,
        totalAmount: true,
      },
    }),
    prisma.payment.aggregate({
      where: {
        businessId,
        verified: true,
        createdAt: {
          gte: dateRange.start,
          lte: dateRange.end,
        },
      },
      _sum: { amount: true },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let totalRevenue = 0;

  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
    totalRevenue += Number(order.totalAmount);
  }

  const totalPaid = Number(totalPaidAgg._sum.amount ?? 0);

  return {
    totalOrders: orders.length,
    byStatus,
    totalRevenue,
    totalPaid,
    pendingAmount: totalRevenue - totalPaid,
  };
}
