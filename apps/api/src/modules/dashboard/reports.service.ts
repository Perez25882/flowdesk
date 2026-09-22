import { prisma } from '../../config/database.js';

/**
 * Revenue and orders over a period, and the same figures as a spreadsheet.
 *
 * The dashboard answers "what is happening now". This answers "how is the shop
 * doing", which is a different question and the one an owner is asked by a
 * landlord, a supplier offering terms, or a bank. Until now the only honest
 * answer available in Flowdesk was "open the orders page and count".
 *
 * Every figure counts settled money, never claimed money — the same rule as the
 * dashboard and the daily summary. A report that flatters by counting
 * screenshots nobody verified is worse than no report, because it gets shown to
 * someone who will act on it.
 */

export type ReportWindow = 30 | 60 | 90;

export interface DayPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  revenue: number;
  orders: number;
}

export interface ReportSummary {
  days: ReportWindow;
  from: string;
  to: string;
  revenue: number;
  orders: number;
  ordersCompleted: number;
  ordersPending: number;
  ordersCancelled: number;
  /** Settled money divided by orders that were not cancelled. */
  averageOrderValue: number;
  /** Money asked for through payment links that is still outstanding. */
  outstanding: number;
  series: DayPoint[];
  topProducts: Array<{ name: string; quantity: number; value: number }>;
  /** The same window, immediately before it — for a change figure. */
  previous: { revenue: number; orders: number };
}

function startOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The window, as whole days ending today.
 *
 * Ghana is UTC+0 with no daylight saving, so a UTC day boundary is the shop's
 * own day boundary. Stated here because it is the assumption every date in this
 * file rests on.
 */
function windowBounds(days: ReportWindow): { start: Date; end: Date; priorStart: Date } {
  const end = new Date(startOfDayUtc(new Date()).getTime() + 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const priorStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end, priorStart };
}

export async function buildReport(
  businessId: string,
  days: ReportWindow,
): Promise<ReportSummary> {
  const { start, end, priorStart } = windowBounds(days);

  const [
    revenue,
    orders,
    completed,
    cancelled,
    pending,
    outstanding,
    revenueByDay,
    ordersByDay,
    topProducts,
    priorRevenue,
    priorOrders,
  ] = await Promise.all([
    prisma.payment.aggregate({
      where: {
        businessId,
        direction: 'IN',
        voidedAt: null,
        confidence: { not: 'CLAIMED' },
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
    }),
    prisma.order.count({ where: { businessId, createdAt: { gte: start, lt: end } } }),
    prisma.order.count({
      where: { businessId, status: 'FULFILLED', createdAt: { gte: start, lt: end } },
    }),
    prisma.order.count({
      where: { businessId, status: 'CANCELLED', createdAt: { gte: start, lt: end } },
    }),
    prisma.order.count({
      where: {
        businessId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        createdAt: { gte: start, lt: end },
      },
    }),
    prisma.paymentRequest.aggregate({
      where: { businessId, status: 'PENDING', expiresAt: { gt: new Date() } },
      _sum: { amount: true },
    }),
    // Grouped in SQL rather than in JS: pulling ninety days of payment rows
    // back to count them is a query that gets slower every month a shop stays.
    prisma.$queryRaw<Array<{ day: Date; total: number }>>`
      SELECT date_trunc('day', "createdAt") AS day, SUM("amount")::float AS total
      FROM "payments"
      WHERE "businessId" = ${businessId}
        AND "direction" = 'IN'
        AND "voidedAt" IS NULL
        AND "confidence" <> 'CLAIMED'
        AND "createdAt" >= ${start}
        AND "createdAt" < ${end}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<Array<{ day: Date; total: number }>>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::float AS total
      FROM "orders"
      WHERE "businessId" = ${businessId}
        AND "createdAt" >= ${start}
        AND "createdAt" < ${end}
      GROUP BY 1
      ORDER BY 1
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
      ORDER BY value DESC
      LIMIT 8
    `,
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
    prisma.order.count({ where: { businessId, createdAt: { gte: priorStart, lt: start } } }),
  ]);

  const totalRevenue = Number(revenue._sum.amount ?? 0);
  const billableOrders = orders - cancelled;

  return {
    days,
    from: isoDate(start),
    to: isoDate(new Date(end.getTime() - 1)),
    revenue: totalRevenue,
    orders,
    ordersCompleted: completed,
    ordersPending: pending,
    ordersCancelled: cancelled,
    // Divided by orders that could have been paid. Including cancellations
    // drags the average down with orders nobody ever intended to pay for, and
    // an owner comparing months would read it as customers spending less.
    averageOrderValue: billableOrders > 0 ? totalRevenue / billableOrders : 0,
    outstanding: Number(outstanding._sum.amount ?? 0),
    series: buildSeries(start, days, revenueByDay, ordersByDay),
    topProducts: topProducts.map((row) => ({
      name: row.description,
      quantity: Number(row.quantity),
      value: Number(row.value),
    })),
    previous: {
      revenue: Number(priorRevenue._sum.amount ?? 0),
      orders: priorOrders,
    },
  };
}

/**
 * One point per day, including the days nothing happened.
 *
 * The gaps matter. A chart drawn only from days with sales makes a shop that
 * sold on three days out of thirty look like a shop that sold every day, which
 * is the single most misleading thing a sales chart can do.
 */
function buildSeries(
  start: Date,
  days: number,
  revenueRows: Array<{ day: Date; total: number }>,
  orderRows: Array<{ day: Date; total: number }>,
): DayPoint[] {
  const revenueByDay = new Map(revenueRows.map((row) => [isoDate(new Date(row.day)), Number(row.total)]));
  const ordersByDay = new Map(orderRows.map((row) => [isoDate(new Date(row.day)), Number(row.total)]));

  const series: DayPoint[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const date = isoDate(new Date(start.getTime() + offset * 24 * 60 * 60 * 1000));
    series.push({
      date,
      revenue: revenueByDay.get(date) ?? 0,
      orders: ordersByDay.get(date) ?? 0,
    });
  }

  return series;
}

/**
 * The report as a spreadsheet.
 *
 * One row per day plus a totals row, because the two things anyone does with
 * this are paste it into their own sheet and send it to somebody. Fields are
 * quoted and internal quotes doubled, so a product name containing a comma does
 * not silently shift every column after it.
 */
export function reportToCsv(report: ReportSummary): string {
  const rows: string[] = [];

  rows.push(`"Flowdesk report","${report.from} to ${report.to}"`);
  rows.push('');
  rows.push('"Date","Revenue (GHS)","Orders"');

  for (const point of report.series) {
    rows.push(`"${point.date}",${point.revenue.toFixed(2)},${point.orders}`);
  }

  rows.push('');
  rows.push(`"Total",${report.revenue.toFixed(2)},${report.orders}`);
  rows.push(`"Completed orders",,${report.ordersCompleted}`);
  rows.push(`"Cancelled orders",,${report.ordersCancelled}`);
  rows.push(`"Average order value",${report.averageOrderValue.toFixed(2)},`);
  rows.push(`"Outstanding on payment links",${report.outstanding.toFixed(2)},`);

  if (report.topProducts.length > 0) {
    rows.push('');
    rows.push('"Product","Quantity","Value (GHS)"');
    for (const product of report.topProducts) {
      rows.push(`${csvField(product.name)},${product.quantity},${product.value.toFixed(2)}`);
    }
  }

  // A BOM, so Excel on Windows opens it as UTF-8 rather than mangling every
  // accented character in a product name.
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

/**
 * One CSV cell: quoted for the columns, defused for the spreadsheet.
 *
 * The quoting is the older guarantee — a product name containing a comma must
 * not shift every field after it, and an internal quote is doubled.
 *
 * The leading apostrophe is the newer one. Excel, Sheets and LibreOffice all
 * evaluate a cell beginning `=`, `+`, `-` or `@` as a formula, and product
 * names are not necessarily something the shop owner typed: they arrive from
 * the catalogue importer's spreadsheet and from the WhatsApp assistant. An
 * apostrophe is the standard neutraliser — the cell reads as text, and the
 * prefix is not shown to whoever opens the file.
 */
function csvField(value: string): string {
  const defused = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${defused.replace(/"/g, '""')}"`;
}
