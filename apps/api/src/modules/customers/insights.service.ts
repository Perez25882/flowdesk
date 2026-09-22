import { prisma } from '../../config/database.js';
import {
  bigSpenderThreshold,
  segmentFor,
  summarise,
  SEGMENT_LABELS,
  type CustomerFacts,
  type SegmentedCustomer,
  type SegmentSummary,
} from './segments.js';
import {
  buildFunnel,
  positionFor,
  worstDropOff,
  STAGE_LABELS,
  type FunnelStep,
  type JourneyStage,
} from './journey.js';

/**
 * The queries behind the customer picture.
 *
 * Every judgement lives in `segments.ts` and `journey.ts`; this file only
 * fetches. That split is what lets the interesting rules — "overdue against
 * their own rhythm", "the biggest fall, not the fullest step" — be tested
 * without a database.
 *
 * Bounded on purpose. A shop with forty thousand customers must not pull forty
 * thousand rows into memory to draw six tiles, so the segment counts come from
 * the rows and the lists are capped at what a person will actually read.
 */

/** Enough to act on. Nobody works a list of five hundred lapsed customers. */
const LIST_LIMIT = 25;

/**
 * The ceiling on rows scanned for segmentation.
 *
 * Ordered by last activity, so the ones cut are the least recently seen — who
 * are by definition already lapsed and would not change a single count that
 * matters. Stated here rather than left implicit because a figure computed from
 * a truncated set is a figure that can quietly stop being true as a shop grows.
 */
const SCAN_LIMIT = 5_000;

export interface CustomerInsights {
  totalCustomers: number;
  /** True when the scan limit was hit and the figures cover recent customers only. */
  truncated: boolean;
  segments: Array<SegmentSummary & { title: string; blurb: string }>;
  /** Overdue against their own pattern, most valuable first. Worth a message today. */
  goingQuiet: Array<{
    id: string;
    name: string | null;
    waNumber: string;
    totalSpend: number;
    totalOrders: number;
    daysSilent: number | null;
    typicalGapDays: number | null;
  }>;
  funnel: Array<FunnelStep & { label: string }>;
  worstStep: { from: JourneyStage; to: JourneyStage; lost: number; rate: number } | null;
}

export async function buildCustomerInsights(businessId: string): Promise<CustomerInsights> {
  const [totalCustomers, rows] = await Promise.all([
    prisma.customer.count({ where: { businessId, deletedAt: null } }),
    prisma.customer.findMany({
      where: { businessId, deletedAt: null, blacklisted: false },
      orderBy: { lastInteractionAt: 'desc' },
      take: SCAN_LIMIT,
      select: {
        id: true,
        name: true,
        waNumber: true,
        totalOrders: true,
        totalSpend: true,
        firstOrderAt: true,
        lastInboundAt: true,
        createdAt: true,
        orders: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    }),
  ]);

  const facts: CustomerFacts[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    waNumber: row.waNumber,
    totalOrders: row.totalOrders,
    totalSpend: Number(row.totalSpend),
    firstOrderAt: row.firstOrderAt,
    lastOrderAt: row.orders[0]?.createdAt ?? null,
    lastInboundAt: row.lastInboundAt,
    createdAt: row.createdAt,
  }));

  const threshold = bigSpenderThreshold(facts.map((f) => f.totalSpend));
  const now = new Date();
  const segmented: SegmentedCustomer[] = facts.map((f) => segmentFor(f, threshold, now));

  const goingQuiet = segmented
    .filter((customer) => customer.segment === 'at_risk')
    // Most valuable first: an owner with ten minutes should spend them on the
    // customer whose loss costs the most, not the one who happens to sort first.
    .sort((a, b) => b.totalSpend - a.totalSpend)
    .slice(0, LIST_LIMIT)
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      waNumber: customer.waNumber,
      totalSpend: customer.totalSpend,
      totalOrders: customer.totalOrders,
      daysSilent: customer.daysSilent,
      typicalGapDays:
        customer.typicalGapDays === null ? null : Math.round(customer.typicalGapDays),
    }));

  const funnel = await buildJourneyFunnel(businessId, now);

  return {
    totalCustomers,
    truncated: rows.length >= SCAN_LIMIT,
    segments: summarise(segmented).map((row) => ({ ...row, ...SEGMENT_LABELS[row.segment] })),
    goingQuiet,
    funnel: funnel.map((step) => ({ ...step, label: STAGE_LABELS[step.stage] })),
    worstStep: worstDropOff(funnel),
  };
}

/**
 * Where conversations stop.
 *
 * Grouped in SQL rather than by loading every message: a shop three months in
 * has tens of thousands of them, and this is drawn on a page an owner opens
 * casually. The three aggregates are keyed by customer and stitched together in
 * one pass.
 */
async function buildJourneyFunnel(businessId: string, now: Date): Promise<FunnelStep[]> {
  const [intentRows, orderRows, linkRows, paymentRows, activityRows] = await Promise.all([
    prisma.$queryRaw<Array<{ customerId: string; intent: string }>>`
      SELECT DISTINCT "customerId", "intent"::text AS intent
      FROM "messages"
      WHERE "businessId" = ${businessId}
        AND "direction" = 'INBOUND'
        AND "customerId" IS NOT NULL
    `,
    prisma.$queryRaw<Array<{ customerId: string; total: bigint }>>`
      SELECT "customerId", COUNT(*) AS total
      FROM "orders"
      WHERE "businessId" = ${businessId} AND "deletedAt" IS NULL
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ customerId: string; total: bigint }>>`
      SELECT "customerId", COUNT(*) AS total
      FROM "payment_requests"
      WHERE "businessId" = ${businessId}
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ customerId: string; total: bigint }>>`
      SELECT "customerId", COUNT(*) AS total
      FROM "payments"
      WHERE "businessId" = ${businessId}
        AND "direction" = 'IN'
        AND "voidedAt" IS NULL
        AND "confidence" <> 'CLAIMED'
        AND "customerId" IS NOT NULL
      GROUP BY 1
    `,
    prisma.customer.findMany({
      where: { businessId, deletedAt: null, blacklisted: false },
      select: { id: true, lastInteractionAt: true },
    }),
  ]);

  const intents = new Map<string, string[]>();
  for (const row of intentRows) {
    const list = intents.get(row.customerId) ?? [];
    list.push(row.intent);
    intents.set(row.customerId, list);
  }

  const countBy = (rows: Array<{ customerId: string; total: bigint }>): Map<string, number> =>
    new Map(rows.map((row) => [row.customerId, Number(row.total)]));

  const orders = countBy(orderRows);
  const links = countBy(linkRows);
  const payments = countBy(paymentRows);

  const positions = activityRows.map((customer) =>
    positionFor(
      {
        customerId: customer.id,
        intents: intents.get(customer.id) ?? [],
        ordersPlaced: orders.get(customer.id) ?? 0,
        paymentLinksSent: links.get(customer.id) ?? 0,
        paymentsSettled: payments.get(customer.id) ?? 0,
        lastActivityAt: customer.lastInteractionAt,
      },
      now,
    ),
  );

  return buildFunnel(positions);
}
