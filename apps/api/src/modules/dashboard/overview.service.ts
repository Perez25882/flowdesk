import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

type OverviewAccess = {
  businessId: string;
  orderAssignee?: string;
  visitAssignee?: string;
  caseAssignee?: string;
  bookings: boolean;
  care: boolean;
  revenue: boolean;
  owner: boolean;
};

export interface ProductOverview {
  orders: { received: number; pending: number; preparing: number; dispatched: number; fulfilled: number };
  visits: { upcoming: number; held: number; completed: number; missed: number; blocked: number } | null;
  care: { open: number } | null;
  money: { verifiedReceipts: string; outstandingInvoices: string; openInvoices: number } | null;
  decisions: { approvals: number; exceptions: number; completed: number } | null;
}

export async function getProductOverview(access: OverviewAccess, now = new Date(), days = 1): Promise<ProductOverview> {
  const { businessId } = access;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const future = new Date(+now + 7 * 86_400_000);
  const orderWhere = { businessId, deletedAt: null, ...(access.orderAssignee ? { assignedStaffId: access.orderAssignee } : {}) };
  const appointmentScope = access.visitAssignee ? Prisma.sql`AND v."assignedStaffId" = ${access.visitAssignee}` : Prisma.empty;
  const [received, orderRows, visits, care, receipts, invoices, work] = await Promise.all([
    prisma.order.count({ where: { ...orderWhere, createdAt: { gte: start, lte: now } } }),
    prisma.order.groupBy({ by: ['status'], where: orderWhere,
      _count: { _all: true } }),
    access.bookings ? prisma.$queryRaw<ProductOverview['visits'][]> `
      SELECT count(*) FILTER (WHERE a."startsAt" BETWEEN ${now} AND ${future} AND a.status IN ('BOOKED','CONFIRMED') AND v.state IS DISTINCT FROM 'HELD')::int AS upcoming,
        count(*) FILTER (WHERE v.state = 'HELD' AND v."holdUntil" > ${now})::int AS held,
        count(*) FILTER (WHERE a.status = 'COMPLETED' AND a."updatedAt" BETWEEN ${start} AND ${now})::int AS completed,
        count(*) FILTER (WHERE a.status = 'NO_SHOW' AND a."updatedAt" BETWEEN ${start} AND ${now})::int AS missed,
        count(*) FILTER (WHERE v.state = 'BLOCKED')::int AS blocked
      FROM appointments a LEFT JOIN service_visits v ON v."appointmentId" = a.id AND v."businessId" = a."businessId"
      WHERE a."businessId" = ${businessId} ${appointmentScope}
    ` : null,
    access.care ? prisma.commerceCase.count({ where: { businessId, state: { not: 'RESOLVED' },
      ...(access.caseAssignee ? { OR: [{ assignedStaffId: access.caseAssignee }, { assignedStaffId: null }] } : {}) } }) : null,
    access.revenue ? prisma.payment.aggregate({ where: { businessId, voidedAt: null, direction: 'IN',
      confidence: 'GATEWAY_CONFIRMED', paystackSettlement: { isNot: null }, createdAt: { gte: start, lte: now } }, _sum: { amount: true } }) : null,
    access.revenue ? prisma.$queryRaw<{ due: Prisma.Decimal; count: number }[]>`
      SELECT coalesce(sum(greatest(0, i.total - coalesce(p.paid,0))), 0) AS due,
        count(*) FILTER (WHERE i.total > coalesce(p.paid,0))::int AS count
      FROM commerce_invoices i LEFT JOIN orders o ON o.id = i."orderId"
      LEFT JOIN service_visits v ON v."invoiceId" = i.id
      LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN p.direction = 'IN' THEN p.amount ELSE -p.amount END) AS paid
        FROM payments p LEFT JOIN paystack_settlements s ON s."paymentId" = p.id
        WHERE p."businessId" = i."businessId" AND p."customerId" = i."customerId" AND p."voidedAt" IS NULL
          AND p.confidence <> 'CLAIMED'
          AND ((i."orderId" IS NOT NULL AND p."orderId" = i."orderId") OR
            (i."orderId" IS NULL AND p."orderId" IS NULL AND p."invoiceId" = i.id AND (p.direction = 'OUT' OR
              (p.confidence = 'GATEWAY_CONFIRMED' AND s.id IS NOT NULL))))
      ) p ON true
      WHERE i."businessId" = ${businessId} AND i.status = 'ISSUED'
        AND (i."orderId" IS NULL OR (o."businessId" = i."businessId" AND o.status <> 'CANCELLED' AND o."deletedAt" IS NULL))
        AND (v.state IS NULL OR v.state NOT IN ('CANCELLED','EXPIRED','NO_SHOW'))
    ` : null,
    access.owner ? prisma.workflow.groupBy({ by: ['state'], _count: { _all: true }, where: { businessId, OR: [
      { state: { in: ['WAITING_OWNER_APPROVAL', 'REVIEW_REQUIRED'] } },
      { state: 'COMPLETED', updatedAt: { gte: start, lte: now } },
    ] } }) : null,
  ]);
  const order = new Map(orderRows.map((row) => [row.status, row._count._all]));
  const states = new Map(work?.map((row) => [row.state, row._count._all]));
  return {
    orders: { received, pending: order.get('PENDING') ?? 0, preparing: (order.get('CONFIRMED') ?? 0) + (order.get('PROCESSING') ?? 0),
      dispatched: order.get('DISPATCHED') ?? 0, fulfilled: order.get('FULFILLED') ?? 0 },
    visits: visits?.[0] ?? null,
    care: care === null ? null : { open: care },
    money: receipts && invoices?.[0] ? { verifiedReceipts: (receipts._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      outstandingInvoices: invoices[0].due.toFixed(2), openInvoices: invoices[0].count } : null,
    decisions: work ? { approvals: states.get('WAITING_OWNER_APPROVAL') ?? 0, exceptions: states.get('REVIEW_REQUIRED') ?? 0,
      completed: states.get('COMPLETED') ?? 0 } : null,
  };
}
