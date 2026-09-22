/**
 * Who a shop's customers are, and which of them are slipping away.
 *
 * Pure functions, no database. The queries live in `segments.service.ts`; the
 * judgements live here so they can be argued with in a test rather than
 * discovered in production.
 *
 * The one idea worth defending: "at risk" is measured against each customer's
 * OWN rhythm, not a fixed number of days. A fixed threshold — the obvious
 * implementation, and what most dashboards do — is wrong in both directions at
 * once. Someone who restocks every week and has been quiet for a month is in
 * trouble; someone who buys a gas cylinder twice a year and was last seen in
 * March is behaving normally. Flagging both at "60 days silent" tells the owner
 * to chase the wrong person and says nothing about the one they are losing.
 */

export const SEGMENTS = [
  'new',
  'regular',
  'big_spender',
  'at_risk',
  'lapsed',
  'browser',
] as const;

export type Segment = (typeof SEGMENTS)[number];

export interface CustomerFacts {
  id: string;
  name: string | null;
  waNumber: string;
  totalOrders: number;
  totalSpend: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  lastInboundAt: Date | null;
  createdAt: Date;
}

export interface SegmentedCustomer extends CustomerFacts {
  segment: Segment;
  /** Days since they last said anything, or null if they never have. */
  daysSilent: number | null;
  /**
   * Their own average gap between orders, in days. Null with fewer than two
   * orders, because one order establishes no rhythm to be late against.
   */
  typicalGapDays: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

/** Never seen at all counts as lapsed rather than as a division by zero. */
const LAPSED_DAYS = 90;
const NEW_WINDOW_DAYS = 30;
const REGULAR_ORDERS = 3;

/**
 * How overdue a customer has to be before it means something.
 *
 * Twice their usual gap. Not 1.5, which flags half a shop every week and
 * trains an owner to ignore the list; not 3, by which point they have found
 * somewhere else. Twice is late enough that a person would notice on their own
 * and early enough that a message still lands.
 */
const OVERDUE_MULTIPLE = 2;

/**
 * A floor under the overdue rule.
 *
 * A customer who ordered twice in one afternoon has a "typical gap" of a few
 * hours, and without this they are at risk by dinner. Two weeks is the shortest
 * silence that means anything for a shop selling to the same people repeatedly.
 */
const MIN_OVERDUE_DAYS = 14;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
}

/**
 * The average gap between this customer's orders, in days.
 *
 * Derived from first order, last order and the count rather than from every
 * order date: it is the same number for evenly spaced orders, needs one row
 * instead of all of them, and the error on an uneven series does not change
 * which side of "twice this" anybody falls on.
 */
export function typicalGapDays(facts: CustomerFacts): number | null {
  if (facts.totalOrders < 2) return null;
  if (!facts.firstOrderAt || !facts.lastOrderAt) return null;

  const span = daysBetween(facts.firstOrderAt, facts.lastOrderAt);
  if (span <= 0) return null;

  return span / (facts.totalOrders - 1);
}

/**
 * Which group a customer is in.
 *
 * Ordered most-urgent-first and returns on the first match, because a customer
 * is shown in exactly one place. A big spender who has gone quiet is at risk —
 * that is the whole point of the list — so `at_risk` is tested before
 * `big_spender`.
 */
export function segmentFor(
  facts: CustomerFacts,
  bigSpenderThreshold: number,
  now: Date = new Date(),
): SegmentedCustomer {
  const lastSeen = facts.lastInboundAt ?? facts.lastOrderAt;
  const daysSilent = lastSeen ? daysBetween(lastSeen, now) : null;
  const gap = typicalGapDays(facts);

  const base = { ...facts, daysSilent, typicalGapDays: gap };

  // Bought nothing, ever. Not a failure — most people who message a shop are
  // asking a question — but not a customer to chase for a repeat order either.
  if (facts.totalOrders === 0) {
    return { ...base, segment: 'browser' };
  }

  if (daysSilent !== null && daysSilent >= LAPSED_DAYS) {
    return { ...base, segment: 'lapsed' };
  }

  if (gap !== null && daysSilent !== null) {
    const overdueAfter = Math.max(gap * OVERDUE_MULTIPLE, MIN_OVERDUE_DAYS);
    if (daysSilent >= overdueAfter) {
      return { ...base, segment: 'at_risk' };
    }
  }

  if (bigSpenderThreshold > 0 && facts.totalSpend >= bigSpenderThreshold) {
    return { ...base, segment: 'big_spender' };
  }

  if (facts.totalOrders >= REGULAR_ORDERS) {
    return { ...base, segment: 'regular' };
  }

  if (facts.firstOrderAt && daysBetween(facts.firstOrderAt, now) <= NEW_WINDOW_DAYS) {
    return { ...base, segment: 'new' };
  }

  // One or two orders, not recent, not yet overdue by their own rhythm. There
  // is nothing useful to say about them, and 'regular' would be a lie.
  return { ...base, segment: 'new' };
}

/**
 * What counts as a big spender in THIS shop.
 *
 * The 80th percentile of customers who have actually bought something, not a
 * cedi figure. GHS 500 is a whale at a chop bar and a rounding error at a
 * furniture shop, and a threshold that has to be configured is a threshold
 * nobody sets.
 *
 * Returns 0 when there is not enough trade to rank anybody, which switches the
 * segment off rather than crowning whoever happens to be top of four customers.
 */
export function bigSpenderThreshold(spends: number[]): number {
  const paying = spends.filter((value) => value > 0).sort((a, b) => a - b);
  if (paying.length < 5) return 0;

  const index = Math.floor(paying.length * 0.8);
  return paying[Math.min(index, paying.length - 1)] ?? 0;
}

export interface SegmentSummary {
  segment: Segment;
  count: number;
  /** Total historic spend of everyone in this group. */
  value: number;
}

export function summarise(customers: SegmentedCustomer[]): SegmentSummary[] {
  const counts = new Map<Segment, { count: number; value: number }>();
  for (const segment of SEGMENTS) counts.set(segment, { count: 0, value: 0 });

  for (const customer of customers) {
    const row = counts.get(customer.segment)!;
    row.count += 1;
    row.value += customer.totalSpend;
  }

  return SEGMENTS.map((segment) => ({ segment, ...counts.get(segment)! }));
}

/** Plain English, because the owner reading this did not pick these names. */
export const SEGMENT_LABELS: Record<Segment, { title: string; blurb: string }> = {
  new: {
    title: 'New',
    blurb: 'Bought for the first time recently.',
  },
  regular: {
    title: 'Regulars',
    blurb: 'Three or more orders and still around.',
  },
  big_spender: {
    title: 'Best customers',
    blurb: 'Your top fifth by money spent.',
  },
  at_risk: {
    title: 'Going quiet',
    blurb: 'Overdue against their own buying pattern. Worth a message today.',
  },
  lapsed: {
    title: 'Gone',
    blurb: 'Nothing from them in three months.',
  },
  browser: {
    title: 'Never bought',
    blurb: 'They have messaged you but never ordered.',
  },
};
