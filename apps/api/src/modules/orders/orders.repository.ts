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
  /** Matcher score, persisted so low-confidence lines can be reviewed. */
  matchConfidence?: number;
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
          matchConfidence: item.matchConfidence ?? null,
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
  // The staff member must belong to THIS business. The order update below is
  // scoped by businessId, but `assignedStaffId` was trusted verbatim — so one
  // tenant could pin another tenant's employee onto its own order, breaking the
  // foreign key's tenant boundary and exposing that employee to order data
  // through any assignment-scoped read.
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, businessId, active: true },
    select: { id: true },
  });

  if (!staff) {
    throw new NotFoundError('Staff member not found');
  }

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

/**
 * Highest reference number already issued to this business, used to seed the
 * Redis counter. Ordering lexically would rank FD-9 above FD-10, so the
 * comparison is done on the parsed numeric suffix.
 */
async function highestReferenceNumber(
  businessId: string,
  tx?: PrismaTransaction,
): Promise<number> {
  const db = tx ?? prisma;

  const orders = await db.order.findMany({
    where: { businessId, referenceNumber: { startsWith: REFERENCE_PREFIX } },
    select: { referenceNumber: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  let highest = 0;

  for (const order of orders) {
    const parsed = Number.parseInt(order.referenceNumber.slice(REFERENCE_PREFIX.length), 10);
    if (!Number.isNaN(parsed) && parsed > highest) {
      highest = parsed;
    }
  }

  return highest;
}

/**
 * Non-sequential fallback used only when Redis is unreachable. Base36 timestamp
 * plus random suffix — unique, sortable by time, and visibly distinct from the
 * normal sequence so support can tell the two apart.
 */
function fallbackReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase().padStart(8, '0');
  const noise = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0');
  return `${REFERENCE_PREFIX}${timestamp}${noise}`;
}

/**
 * Allocates the next per-business reference.
 *
 * The counter lives in Redis (atomic INCR) but is seeded from the database the
 * first time a business is seen, so a flushed cache resumes the sequence
 * instead of restarting at 1 and colliding with existing orders.
 */
export async function generateOrderReference(
  businessId: string,
  tx?: PrismaTransaction,
): Promise<string> {
  const key = `${REDIS_REF_KEY_PREFIX}${businessId}`;

  try {
    // SET NX: whichever concurrent caller seeds first wins; the rest no-op and
    // then INCR from that shared baseline.
    if ((await redis.exists(key)) === 0) {
      const highest = await highestReferenceNumber(businessId, tx);
      await redis.set(key, String(highest), 'NX');
    }

    return padReference(await redis.incr(key));
  } catch (error: unknown) {
    logger.warn(
      { error, businessId },
      'Redis unavailable for order reference — using timestamp fallback',
    );
    return fallbackReference();
  }
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
