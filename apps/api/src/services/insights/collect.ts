import { prisma } from '../../config/database.js';

/**
 * Yesterday, in numbers.
 *
 * Every figure the morning summary is allowed to contain comes from here, and
 * the narrative is checked against it before it is stored. That is the same
 * contract the customer-facing assistant works under and it matters more here,
 * not less: a reply invents a price for one customer, whereas a summary that
 * invents a revenue figure is what an owner makes next week's buying decision
 * on.
 *
 * Counts are deliberately cheap. This runs once per shop per day, but it runs
 * for every shop at the same moment, so a query that is fine for one is a
 * thundering herd for four hundred.
 */

export interface DayFacts {
  /** The day reported on, as `YYYY-MM-DD`. */
  date: string;
  /** Messages a customer sent. */
  messagesIn: number;
  /** Replies that went out, by whatever path. */
  messagesOut: number;
  /** Distinct customers who wrote. */
  customersWhoWrote: number;
  /** Customers writing for the first time. */
  newCustomers: number;
  ordersCreated: number;
  ordersValue: number;
  ordersFulfilled: number;
  ordersCancelled: number;
  /** Money actually received — attested or gateway-confirmed, not claimed. */
  revenue: number;
  /** Payment links sent that nobody has paid yet. */
  paymentLinksOpen: number;
  paymentLinksOpenValue: number;
  /** Messages still waiting on the owner right now. */
  awaitingOwner: number;
  /** Replies the assistant sent with a claim it could not verify. */
  unverifiedRepliesSent: number;
  /** Products at or below their reorder threshold right now. */
  lowStockCount: number;
  lowStockNames: string[];
  /** Best sellers yesterday, by quantity. */
  topProducts: Array<{ name: string; quantity: number; value: number }>;
  /** The same figures for the day before, so a change can be described. */
  previous: {
    messagesIn: number;
    ordersCreated: number;
    revenue: number;
  };
}

/** Midnight to midnight, UTC — which is Ghanaian local time, with no offset. */
function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day before `reference`, which is what a morning summary reports on. */
export function previousDay(reference: Date = new Date()): Date {
  return new Date(reference.getTime() - 24 * 60 * 60 * 1000);
}

export async function collectDayFacts(businessId: string, day: Date): Promise<DayFacts> {
  const { start, end } = dayBounds(day);
  const priorStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);

  const [
    messagesIn,
    messagesOut,
    customerIds,
    ordersCreated,
    ordersFulfilled,
    ordersCancelled,
    revenue,
    openLinks,
    awaitingOwner,
    unverifiedRepliesSent,
    lowStock,
    topProducts,
    prevMessagesIn,
    prevOrders,
    prevRevenue,
    newCustomers,
  ] = await Promise.all([
    prisma.message.count({
      where: { businessId, direction: 'INBOUND', createdAt: { gte: start, lt: end } },
    }),
    prisma.message.count({
      where: { businessId, direction: 'OUTBOUND', createdAt: { gte: start, lt: end } },
    }),
    prisma.message.findMany({
      where: { businessId, direction: 'INBOUND', createdAt: { gte: start, lt: end } },
      distinct: ['customerId'],
      select: { customerId: true },
    }),
    prisma.order.aggregate({
      where: { businessId, createdAt: { gte: start, lt: end } },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.order.count({
      where: { businessId, status: 'FULFILLED', updatedAt: { gte: start, lt: end } },
    }),
    prisma.order.count({
      where: { businessId, status: 'CANCELLED', updatedAt: { gte: start, lt: end } },
    }),
    prisma.payment.aggregate({
      where: {
        businessId,
        direction: 'IN',
        voidedAt: null,
        // Claimed money is not money. Only what somebody attested or a gateway
        // confirmed counts, which is the same rule the dashboard uses.
        confidence: { not: 'CLAIMED' },
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
    }),
    prisma.paymentRequest.aggregate({
      where: { businessId, status: 'PENDING', expiresAt: { gt: new Date() } },
      _count: true,
      _sum: { amount: true },
    }),
    // Not scoped to the day: what is waiting NOW is what the owner has to do
    // something about this morning, whenever it arrived.
    prisma.message.count({
      where: { businessId, requiresReview: true, direction: 'INBOUND' },
    }),
    prisma.message.count({
      where: {
        businessId,
        direction: 'INBOUND',
        aiReplyStatus: 'SENT',
        // `isEmpty: false` is the only way to ask Postgres for a non-empty
        // array through Prisma; `not: []` matches nothing.
        aiValidationFailed: { isEmpty: false },
        createdAt: { gte: start, lt: end },
      },
    }),
    prisma.$queryRaw<Array<{ name: string }>>`
      SELECT "name"
      FROM "products"
      WHERE "businessId" = ${businessId}
        AND "deletedAt" IS NULL
        AND "active" = true
        AND "reorderThreshold" > 0
        AND "stockQuantity" <= "reorderThreshold"
      ORDER BY ("stockQuantity" - "reorderThreshold") ASC
      LIMIT 20
    `,
    prisma.$queryRaw<Array<{ description: string; quantity: number; value: number }>>`
      SELECT oi."description",
             SUM(oi."quantity")::float AS quantity,
             SUM(oi."subtotal")::float AS value
      FROM "order_items" oi
      JOIN "orders" o ON o."id" = oi."orderId"
      WHERE o."businessId" = ${businessId}
        AND o."createdAt" >= ${start}
        AND o."createdAt" < ${end}
        AND o."status" <> 'CANCELLED'
      GROUP BY oi."description"
      ORDER BY quantity DESC
      LIMIT 3
    `,
    prisma.message.count({
      where: { businessId, direction: 'INBOUND', createdAt: { gte: priorStart, lt: start } },
    }),
    prisma.order.count({ where: { businessId, createdAt: { gte: priorStart, lt: start } } }),
    prisma.payment.aggregate({
      where: {
        businessId,
        direction: 'IN',
        voidedAt: null,
        confidence: { not: 'CLAIMED' },
        createdAt: { gte: priorStart, lt: start },
      },
      _sum: { amount: true },
    }),
    prisma.customer.count({ where: { businessId, createdAt: { gte: start, lt: end } } }),
  ]);

  return {
    date: isoDate(start),
    messagesIn,
    messagesOut,
    customersWhoWrote: customerIds.filter((row) => row.customerId !== null).length,
    newCustomers,
    ordersCreated: ordersCreated._count,
    ordersValue: Number(ordersCreated._sum.totalAmount ?? 0),
    ordersFulfilled,
    ordersCancelled,
    revenue: Number(revenue._sum.amount ?? 0),
    paymentLinksOpen: openLinks._count,
    paymentLinksOpenValue: Number(openLinks._sum.amount ?? 0),
    awaitingOwner,
    unverifiedRepliesSent,
    lowStockCount: lowStock.length,
    lowStockNames: lowStock.map((row) => row.name),
    topProducts: topProducts.map((row) => ({
      name: row.description,
      quantity: Number(row.quantity),
      value: Number(row.value),
    })),
    previous: {
      messagesIn: prevMessagesIn,
      ordersCreated: prevOrders,
      revenue: Number(prevRevenue._sum.amount ?? 0),
    },
  };
}

/**
 * Whether there is anything worth writing about.
 *
 * A shop that had no messages, no orders and no money yesterday gets nothing.
 * A daily summary that says "nothing happened" every morning for a fortnight is
 * a notification people mute, and once muted it is gone for the morning that
 * mattered.
 */
export function hasSomethingToSay(facts: DayFacts): boolean {
  return (
    facts.messagesIn > 0 ||
    facts.ordersCreated > 0 ||
    facts.revenue > 0 ||
    facts.awaitingOwner > 0 ||
    facts.lowStockCount > 0
  );
}
