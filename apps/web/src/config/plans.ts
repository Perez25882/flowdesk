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
 */

export type PlanCode = 'TRIAL' | 'STARTER' | 'BUSINESS' | 'GROWTH' | 'ENTERPRISE' | 'SUSPENDED';

/** The codes a customer can actually buy. */
export const BILLABLE_PLAN_CODES = ['STARTER', 'BUSINESS', 'GROWTH'] as const;
export type BillablePlanCode = (typeof BILLABLE_PLAN_CODES)[number];

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
    reports: boolean;
    priorityMatching: boolean;
    broadcasts: boolean;
    namedSupport: boolean;
  };
  /** Marked on both surfaces so the recommendation never disagrees. */
  recommended: boolean;
}

export const PLANS: Record<PlanCode, Plan> = {
  TRIAL: {
    code: 'TRIAL',
    name: 'Trial',
    price: 'Free',
    period: 'for 14 days',
    audience: 'Every account starts here.',
    conversationsPerMonth: 100,
    ordersPerMonth: null,
    staffSeats: 1,
    products: null,
    features: {
      customTemplates: true,
      reports: true,
      priorityMatching: true,
      broadcasts: false,
      namedSupport: false,
    },
    recommended: false,
  },
  STARTER: {
    code: 'STARTER',
    name: 'Starter',
    price: 'GHS 150',
    period: 'per month',
    audience: 'A single shop, run by you.',
    conversationsPerMonth: 500,
    ordersPerMonth: null,
    staffSeats: 1,
    products: null,
    features: {
      customTemplates: false,
      reports: false,
      priorityMatching: false,
      broadcasts: false,
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
    conversationsPerMonth: 2_500,
    ordersPerMonth: null,
    staffSeats: 5,
    products: null,
    features: {
      customTemplates: true,
      reports: true,
      priorityMatching: true,
      broadcasts: false,
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
    staffSeats: null,
    products: null,
    features: {
      customTemplates: true,
      reports: true,
      priorityMatching: true,
      broadcasts: true,
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
      reports: true,
      priorityMatching: true,
      broadcasts: true,
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
    conversationsPerMonth: null,
    ordersPerMonth: null,
    staffSeats: null,
    products: null,
    features: {
      customTemplates: false,
      reports: false,
      priorityMatching: false,
      broadcasts: false,
      namedSupport: false,
    },
    recommended: false,
  },
};

/** `null` reads as no ceiling, not as zero. */
export function limit(value: number | null, unlimitedLabel = 'Unlimited'): string {
  return value === null ? unlimitedLabel : value.toLocaleString('en-GB');
}

/** The rows of the comparison table, derived so the two views cannot drift. */
export const PLAN_COMPARISON: {
  label: string;
  value: (plan: Plan) => string | boolean;
}[] = [
  { label: 'Conversations a month', value: (p) => limit(p.conversationsPerMonth) },
  { label: 'Orders', value: (p) => limit(p.ordersPerMonth) },
  { label: 'Staff accounts', value: (p) => limit(p.staffSeats) },
  { label: 'Products', value: (p) => limit(p.products) },
  { label: 'Automatic replies', value: () => true },
  { label: 'Your own reply wording', value: (p) => p.features.customTemplates },
  { label: 'Weekly reports', value: (p) => p.features.reports },
  { label: 'Priority payment matching', value: (p) => p.features.priorityMatching },
  { label: 'Broadcasts', value: (p) => p.features.broadcasts },
  { label: 'Named support contact', value: (p) => p.features.namedSupport },
];

/** Short bullets for the billing screen, generated from the same flags. */
export function planHighlights(plan: Plan): string[] {
  const out: string[] = [
    `${limit(plan.conversationsPerMonth)} conversations a month`,
    `${limit(plan.staffSeats)} staff ${plan.staffSeats === 1 ? 'account' : 'accounts'}`,
  ];
  if (plan.features.reports) out.push('Weekly reports');
  if (plan.features.broadcasts) out.push('Broadcasts');
  if (plan.features.namedSupport) out.push('Named support contact');
  return out;
}

export function getPlan(code: string): Plan {
  return PLANS[code as PlanCode] ?? PLANS.STARTER;
}
