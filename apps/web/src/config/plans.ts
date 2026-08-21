/**
 * Plans — the single source of truth.
 *
 * The marketing page and the billing screen were quoting different products.
 * Landing said GHS 149 and GHS 399 with 2,000 conversations on the middle
 * tier; Settings said GHS 350 and GHS 700 with 2,500. A visitor who signed up
 * on the strength of the landing page found a different price at checkout,
 * which is the fastest way to lose someone who has already decided to pay.
 *
 * The billing screen is authoritative, because it is the one wired to the
 * payment provider. Those figures are reproduced here once, and both surfaces
 * import them. Any future change happens in this file or not at all.
 *
 * That rule held for price and then quietly failed for everything else: this
 * file went on advertising unlimited products, unlimited orders and unlimited
 * staff seats that `PLAN_LIMITS` in
 * `apps/api/src/services/plan/plan.service.ts` refuses, and features — weekly
 * reports, broadcasts, priority payment matching — that no code implements.
 * A limit quoted more generously than the API enforces is not marketing, it is
 * a support ticket with a delay on it.
 *
 * So the rule is now specific. Every number below is copied from
 * `PLAN_LIMITS`, and every feature row names something a customer can find in
 * the product today. Changing a limit means changing `plan.service.ts` first
 * and this file second; adding a feature row means the feature exists.
 * Last checked against `plan.service.ts` and `billing.schema.ts` on 2026-08-20.
 */

/**
 * Matches Prisma's `BusinessPlan` exactly.
 *
 * There is deliberately no `TRIAL` member. A trial is not a plan: registration
 * stamps `trialEndsAt` and leaves the business on whatever plan its row holds,
 * so a `TRIAL` entry here could only ever be a set of numbers nothing enforces
 * — which is precisely what the old one was.
 */
export type PlanCode = 'STARTER' | 'BUSINESS' | 'GROWTH' | 'ENTERPRISE' | 'SUSPENDED';

/** The codes a customer can actually buy. */
export const BILLABLE_PLAN_CODES = ['STARTER', 'BUSINESS', 'GROWTH'] as const;
export type BillablePlanCode = (typeof BILLABLE_PLAN_CODES)[number];

/** `TRIAL_DAYS` in `apps/api/src/modules/auth/auth.service.ts`. */
export const TRIAL_DAYS = 14;

/** `TRIAL_GRACE_MS` in `apps/api/src/services/plan/plan.service.ts`, in hours. */
export const TRIAL_GRACE_HOURS = 48;

/**
 * What the conversation allowance actually counts.
 *
 * One unit is one WhatsApp message Flowdesk sends on the shop's behalf —
 * counted in the outbound worker, not per thread — so the figure is worth
 * spelling out wherever it is quoted.
 */
export const CONVERSATION_UNIT_NOTE =
  'One conversation is one message Flowdesk sends for you. Go past the monthly allowance and automatic replies pause until the month turns over or you move up a plan — incoming messages and orders keep being recorded either way.';

export interface Plan {
  code: PlanCode;
  name: string;
  /** Formatted for display. `null` where there is nothing to charge. */
  price: string;
  /** Billing period, or the trial length. */
  period: string;
  /** One line on who it is for. Shown on the marketing page only. */
  audience: string;
  conversationsPerMonth: number | null;
  ordersPerMonth: number | null;
  staffSeats: number | null;
  products: number | null;
  features: {
    customTemplates: boolean;
    namedSupport: boolean;
  };
  /** Marked on both surfaces so the recommendation never disagrees. */
  recommended: boolean;
}

export const PLANS: Record<PlanCode, Plan> = {
  STARTER: {
    code: 'STARTER',
    name: 'Starter',
    price: 'GHS 150',
    period: 'per month',
    audience: 'A single shop, run by you.',
    conversationsPerMonth: 500,
    ordersPerMonth: 300,
    staffSeats: 1,
    products: 50,
    features: {
      // Every plan can rewrite the automatic replies — nothing in the API
      // gates `replyTemplates` by plan, so this row cannot claim otherwise.
      customTemplates: true,
      namedSupport: false,
    },
    recommended: false,
  },
  BUSINESS: {
    code: 'BUSINESS',
    name: 'Business',
    price: 'GHS 350',
    period: 'per month',
    audience: 'A shop with staff on the floor.',
    conversationsPerMonth: 2_000,
    ordersPerMonth: null,
    staffSeats: 5,
    products: null,
    features: {
      customTemplates: true,
      namedSupport: false,
    },
    recommended: true,
  },
  GROWTH: {
    code: 'GROWTH',
    name: 'Growth',
    price: 'GHS 700',
    period: 'per month',
    audience: 'Several locations, one ledger.',
    conversationsPerMonth: 10_000,
    ordersPerMonth: null,
    staffSeats: 20,
    products: null,
    features: {
      customTemplates: true,
      namedSupport: true,
    },
    recommended: false,
  },
  ENTERPRISE: {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    price: 'Custom',
    period: 'talk to us',
    audience: 'Bespoke terms and integrations.',
    conversationsPerMonth: null,
    ordersPerMonth: null,
    staffSeats: null,
    products: null,
    features: {
      customTemplates: true,
      namedSupport: true,
    },
    recommended: false,
  },
  SUSPENDED: {
    code: 'SUSPENDED',
    name: 'Suspended',
    price: '—',
    period: '',
    audience: '',
    // Zeroes rather than nulls: `PLAN_LIMITS.SUSPENDED` is zero across the
    // board, and a suspended account rendering "Unlimited conversations a
    // month" in Settings is the most confusing possible thing to show someone
    // whose account has stopped working.
    conversationsPerMonth: 0,
    ordersPerMonth: 0,
    staffSeats: 0,
    products: 0,
    features: {
      customTemplates: false,
      namedSupport: false,
    },
    recommended: false,
  },
};

/** `null` reads as no ceiling, not as zero. */
export function limit(value: number | null, unlimitedLabel = 'Unlimited'): string {
  return value === null ? unlimitedLabel : value.toLocaleString('en-GB');
}

/**
 * The rows of the comparison table, derived so the two views cannot drift.
 *
 * Rows that are true on every plan stay in: what a visitor most needs to know
 * about the assistant is that it is not the expensive tier's feature.
 */
export const PLAN_COMPARISON: {
  label: string;
  value: (plan: Plan) => string | boolean;
}[] = [
  { label: 'Conversations a month', value: (p) => limit(p.conversationsPerMonth) },
  { label: 'Orders a month', value: (p) => limit(p.ordersPerMonth) },
  { label: 'Products', value: (p) => limit(p.products) },
  { label: 'Staff accounts', value: (p) => limit(p.staffSeats) },
  { label: 'Automatic replies', value: () => true },
  { label: 'Drafts for anything unverified', value: () => true },
  { label: 'Your own reply wording', value: (p) => p.features.customTemplates },
  { label: 'Named support contact', value: (p) => p.features.namedSupport },
];

/** Short bullets for the billing screen, generated from the same figures. */
export function planHighlights(plan: Plan): string[] {
  const out: string[] = [
    `${limit(plan.conversationsPerMonth)} conversations a month`,
    `${limit(plan.ordersPerMonth)} orders a month`,
    `${limit(plan.products)} products`,
    `${limit(plan.staffSeats)} staff ${plan.staffSeats === 1 ? 'account' : 'accounts'}`,
  ];
  if (plan.features.namedSupport) out.push('Named support contact');
  return out;
}

export function getPlan(code: string): Plan {
  return PLANS[code as PlanCode] ?? PLANS.STARTER;
}
