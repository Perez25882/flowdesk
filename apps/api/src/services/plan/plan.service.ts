import type { BusinessPlan } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { applyDueScheduledChange } from '../billing/plan-schedule.js';

/**
 * Plan limits and usage accounting.
 *
 * Two problems this module exists to solve:
 *
 *   1. The usage counters were never reset. `monthlyConvoCount` only ever grew,
 *      so every business would eventually and permanently exceed its plan.
 *   2. The limit checks were never called. Conversation and order limits were
 *      written but wired to nothing.
 *
 * Enforcement follows the PRD's principle: never lose a customer's data. Hitting
 * a limit degrades outbound behaviour (auto-replies pause) but inbound messages
 * and orders are always stored.
 */

export interface PlanLimits {
  /**
   * Outbound conversation allowance per calendar month.
   *
   * The PRD's enforcement note says "counted per 24hr window", which is Meta's
   * billing unit rather than ours. Every other surface — the pricing page, the
   * plan comparison table, `PLAN_LIMITS` below, the counter column and its
   * reset date — is monthly, and monthly is what an owner paying GHS 150 for
   * "500 conversations" understands they are buying. Splitting the two would
   * mean a shop quoted 500 a month being cut off after 500 in a day, or the
   * dashboard reporting a number that does not match the one being enforced.
   * So the allowance is monthly everywhere: counted monthly, enforced monthly,
   * reported monthly, and reset on the first of the month.
   */
  conversations: number;
  orders: number;
  staff: number;
  products: number;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLAN_LIMITS: Record<BusinessPlan, PlanLimits> = {
  STARTER: { conversations: 500, orders: 300, staff: 1, products: 50 },
  BUSINESS: { conversations: 2_000, orders: UNLIMITED, staff: 5, products: UNLIMITED },
  GROWTH: { conversations: 10_000, orders: UNLIMITED, staff: 20, products: UNLIMITED },
  ENTERPRISE: {
    conversations: UNLIMITED,
    orders: UNLIMITED,
    staff: UNLIMITED,
    products: UNLIMITED,
  },
  SUSPENDED: { conversations: 0, orders: 0, staff: 0, products: 0 },
};

/** Usage fraction at which the owner is warned they are close to the limit. */
export const WARNING_THRESHOLD = 0.9;

/** Grace period after the trial ends before business operations are blocked. */
export const TRIAL_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * The plan a free trial runs on.
 *
 * The PRD sells "14-day free trial on the Business plan… full feature access",
 * and the landing page now promises every plan feature is unlocked during it.
 * Registration only stamps `trialEndsAt` and leaves `plan` at the schema
 * default of STARTER, so without this the trial silently ran on 50 products and
 * one staff seat — both hard-enforced — and the two things a new owner does
 * first, import their catalogue and add their shop assistant, hit a wall the
 * marketing said would not be there.
 *
 * `effectivePlan` is the one place that answers "what is this business
 * entitled to right now", so the trial is expressed there rather than by
 * writing BUSINESS onto the row at signup: the stored plan stays the plan they
 * have actually bought, which is what billing has to reason about.
 */
export const TRIAL_PLAN: BusinessPlan = 'BUSINESS';

/**
 * Tier ordering, so "which of these two entitles more" is one comparison
 * rather than a chain of special cases. Only the order matters — the numbers
 * are never persisted or exposed.
 */
const PLAN_RANK: Record<BusinessPlan, number> = {
  SUSPENDED: -1,
  STARTER: 0,
  BUSINESS: 1,
  GROWTH: 2,
  ENTERPRISE: 3,
};

/** Negative when `a` entitles less than `b`, positive when it entitles more. */
export function comparePlans(a: BusinessPlan, b: BusinessPlan): number {
  return (PLAN_RANK[a] ?? 0) - (PLAN_RANK[b] ?? 0);
}

/** The more generous of two plans. */
export function higherPlan(a: BusinessPlan, b: BusinessPlan): BusinessPlan {
  return comparePlans(a, b) >= 0 ? a : b;
}

interface BusinessPlanState {
  id: string;
  plan: BusinessPlan;
  trialEndsAt: Date | null;
  suspendedAt: Date | null;
  paystackSubCode: string | null;
  monthlyConvoCount: number;
  convoCountResetAt: Date | null;
  monthlyOrderCount: number;
  orderCountResetAt: Date | null;
}

/** First instant of the month after the given date — when counters roll over. */
function startOfNextMonth(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

async function loadPlanState(businessId: string): Promise<BusinessPlanState | null> {
  return prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      plan: true,
      trialEndsAt: true,
      suspendedAt: true,
      paystackSubCode: true,
      monthlyConvoCount: true,
      convoCountResetAt: true,
      monthlyOrderCount: true,
      orderCountResetAt: true,
    },
  });
}

/**
 * Rolls monthly usage counters over when their period has elapsed.
 *
 * Called lazily on read and on increment rather than from a scheduled job, so
 * correctness does not depend on a cron process having run. A business that is
 * idle for three months still gets an accurate count the moment it is touched.
 */
export async function resetCountersIfDue(businessId: string): Promise<void> {
  const business = await loadPlanState(businessId);
  if (!business) return;

  const now = new Date();
  const data: Record<string, unknown> = {};

  if (!business.convoCountResetAt || business.convoCountResetAt <= now) {
    data.monthlyConvoCount = 0;
    data.convoCountResetAt = startOfNextMonth(now);
  }

  if (!business.orderCountResetAt || business.orderCountResetAt <= now) {
    data.monthlyOrderCount = 0;
    data.orderCountResetAt = startOfNextMonth(now);
  }

  if (Object.keys(data).length === 0) return;

  await prisma.business.update({ where: { id: businessId }, data });

  logger.info({ businessId, reset: Object.keys(data) }, 'Monthly usage counters rolled over');
}

/**
 * Brings the row up to date before its plan is read.
 *
 * A downgrade, cancellation or pause takes effect at the end of the period the
 * customer has already paid for, and there is no scheduler in this service to
 * apply it on the day. So it is applied lazily on the next read, exactly as the
 * usage counters are: the effective date is decided and stored when the change
 * is requested, and whoever touches the business next writes it through.
 */
async function refreshPlanState(businessId: string): Promise<void> {
  await Promise.all([resetCountersIfDue(businessId), applyDueScheduledChange(businessId)]);
}

/**
 * The plan actually in force — what this business is entitled to right now, as
 * opposed to the plan it has bought.
 *
 * A suspended account, or an expired trial past its grace period with no
 * subscription, is treated as SUSPENDED regardless of the stored plan.
 */
export function effectivePlan(business: {
  plan: BusinessPlan;
  trialEndsAt: Date | null;
  suspendedAt: Date | null;
  paystackSubCode: string | null;
}): BusinessPlan {
  if (business.suspendedAt) return 'SUSPENDED';

  // A lapsed subscription is recorded by writing SUSPENDED to `plan` itself
  // (see `plan-schedule.ts`), so it must win over anything below — including a
  // trial whose grace window has not technically closed yet.
  if (business.plan === 'SUSPENDED') return 'SUSPENDED';

  if (business.trialEndsAt) {
    const graceEnds = business.trialEndsAt.getTime() + TRIAL_GRACE_MS;

    if (Date.now() <= graceEnds) {
      // Inside the trial, and through its 48-hour grace, the business gets the
      // tier the trial is sold on. `higherPlan` rather than a flat TRIAL_PLAN
      // for the two mid-trial purchases: someone who buys GROWTH on day 3 has
      // paid for GROWTH and must not be pulled back down to BUSINESS for the
      // rest of the trial, and someone who buys STARTER on day 3 keeps the
      // Business entitlements they were promised until day 14 instead of
      // losing features the moment they pay.
      return higherPlan(business.plan, TRIAL_PLAN);
    }

    // Trial and grace both spent. Only a subscription keeps the account alive.
    if (!business.paystackSubCode) return 'SUSPENDED';
  }

  return business.plan;
}

/** Which trial warning the dashboard should be showing, per PRD 3.10. */
export type TrialStage = 'none' | 'prompt' | 'final_day' | 'ended' | 'lapsed';

export interface TrialState {
  /** True while the trial (or its grace) is what is keeping the account open. */
  active: boolean;
  endsAt: Date | null;
  /** When read-only mode starts: `endsAt` plus the 48-hour grace. */
  graceEndsAt: Date | null;
  /** Whole days left, rounded up. Zero on and after the last day. */
  daysRemaining: number | null;
  stage: TrialStage;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days remaining at which the day-10 prompt starts. The trial is 14 days, so
 * day 10 is four days out and day 13 is one — the two milestones PRD 3.10
 * names, expressed as "time left" so they hold if the trial length changes.
 */
const PROMPT_DAYS_REMAINING = 4;

/**
 * The trial countdown, for the dashboard to render on load.
 *
 * There is no scheduler in this service, so nothing can push a day-10 prompt.
 * Deriving the stage from the dates on every read gives the in-app half of PRD
 * 3.10 without one: the dashboard asks what stage it is in and shows the
 * matching prompt. The WhatsApp half needs a job that walks businesses by
 * `trialEndsAt`; see the billing report.
 */
export function trialState(
  business: { trialEndsAt: Date | null; paystackSubCode: string | null },
  now: Date = new Date(),
): TrialState {
  if (!business.trialEndsAt) {
    return { active: false, endsAt: null, graceEndsAt: null, daysRemaining: null, stage: 'none' };
  }

  const endsAt = business.trialEndsAt;
  const graceEndsAt = new Date(endsAt.getTime() + TRIAL_GRACE_MS);
  const daysRemaining = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / MS_PER_DAY));

  // A subscriber is not on trial any more, whatever the dates say. Counting
  // down at someone who has already paid is the fastest way to make them think
  // the payment did not go through.
  if (business.paystackSubCode) {
    return { active: false, endsAt, graceEndsAt, daysRemaining, stage: 'none' };
  }

  const active = now.getTime() <= graceEndsAt.getTime();

  let stage: TrialStage;
  if (now.getTime() > graceEndsAt.getTime()) stage = 'lapsed';
  else if (daysRemaining === 0) stage = 'ended';
  else if (daysRemaining === 1) stage = 'final_day';
  else if (daysRemaining <= PROMPT_DAYS_REMAINING) stage = 'prompt';
  else stage = 'none';

  return { active, endsAt, graceEndsAt, daysRemaining, stage };
}

export interface UsageMeasure {
  used: number;
  /** `Number.POSITIVE_INFINITY` when the plan sets no ceiling. */
  limit: number;
  remaining: number;
  /** At or past `WARNING_THRESHOLD` of the limit. */
  nearLimit: boolean;
  /** At or past the limit. Orders and products still record; outbound pauses. */
  overLimit: boolean;
}

export interface UsageSnapshot {
  plan: BusinessPlan;
  effectivePlan: BusinessPlan;
  conversations: UsageMeasure;
  orders: UsageMeasure;
  staff: UsageMeasure;
  products: UsageMeasure;
  /** When the monthly conversation and order counters roll over. */
  periodEndsAt: Date | null;
  trialEndsAt: Date | null;
  suspended: boolean;
}

function measure(used: number, limit: number): UsageMeasure {
  const remaining = limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    nearLimit: limit !== UNLIMITED && limit > 0 && used / limit >= WARNING_THRESHOLD,
    overLimit: limit !== UNLIMITED && used >= limit,
  };
}

/** Full usage picture for the billing/settings screens. */
export async function getUsage(businessId: string): Promise<UsageSnapshot | null> {
  await refreshPlanState(businessId);

  const business = await loadPlanState(businessId);
  if (!business) return null;

  const [staffCount, productCount] = await Promise.all([
    prisma.staff.count({ where: { businessId, active: true } }),
    prisma.product.count({ where: { businessId, deletedAt: null } }),
  ]);

  const active = effectivePlan(business);
  const limits = PLAN_LIMITS[active];

  return {
    plan: business.plan,
    effectivePlan: active,
    conversations: measure(business.monthlyConvoCount, limits.conversations),
    orders: measure(business.monthlyOrderCount, limits.orders),
    staff: measure(staffCount, limits.staff),
    products: measure(productCount, limits.products),
    periodEndsAt: business.convoCountResetAt,
    trialEndsAt: business.trialEndsAt,
    suspended: active === 'SUSPENDED',
  };
}

/** One thing the dashboard should tell the owner about their usage. */
export interface UsageWarning {
  resource: 'conversations' | 'orders' | 'staff' | 'products';
  /** `near` at 90% of the limit, `over` at 100%. */
  level: 'near' | 'over';
  used: number;
  limit: number;
  /** Whether hitting this limit stops anything, or only prompts an upgrade. */
  blocking: boolean;
  message: string;
}

/**
 * The 90%-and-over warnings, ready to render.
 *
 * These were computed inside `getUsage` as a bare `nearLimit` boolean that no
 * screen ever read, so an owner sailed past 90% of their conversations with no
 * hint until the auto-replies went quiet. Deriving the sentence here keeps the
 * wording — and, more importantly, the claim about what actually stops — in the
 * same file as the enforcement that makes it true.
 */
export function usageWarnings(usage: UsageSnapshot): UsageWarning[] {
  const warnings: UsageWarning[] = [];

  const add = (
    resource: UsageWarning['resource'],
    m: UsageMeasure,
    blocking: boolean,
    over: string,
    near: string,
  ): void => {
    if (m.limit === UNLIMITED) return;
    if (!m.nearLimit && !m.overLimit) return;

    warnings.push({
      resource,
      level: m.overLimit ? 'over' : 'near',
      used: m.used,
      limit: m.limit,
      blocking,
      message: m.overLimit ? over : near,
    });
  };

  add(
    'conversations',
    usage.conversations,
    true,
    `You have used all ${usage.conversations.limit} conversations on your plan this month. Automatic replies are paused until the month turns over or you move up a plan — messages and orders are still coming in and being recorded.`,
    `You have used ${usage.conversations.used} of ${usage.conversations.limit} conversations this month. Automatic replies pause when you reach the limit.`,
  );

  // Orders are counted but never blocked, which is what the PRD asks for: no
  // order is ever refused. The owner still needs telling, because the number
  // they are past is the one they are paying for.
  add(
    'orders',
    usage.orders,
    false,
    `You have taken ${usage.orders.used} orders this month, past the ${usage.orders.limit} your plan includes. Nothing is blocked and no order is lost — move up a plan when it suits you.`,
    `You have taken ${usage.orders.used} of the ${usage.orders.limit} orders your plan includes this month.`,
  );

  add(
    'staff',
    usage.staff,
    true,
    `All ${usage.staff.limit} staff accounts on your plan are in use. Move up a plan to invite anyone else.`,
    `You are using ${usage.staff.used} of ${usage.staff.limit} staff accounts.`,
  );

  add(
    'products',
    usage.products,
    true,
    `Your catalogue is full at ${usage.products.limit} products. Move up a plan to add more — nothing already listed is affected.`,
    `You have ${usage.products.used} of ${usage.products.limit} products listed.`,
  );

  return warnings;
}

/** Something a business is already over, on a plan it is about to move down to. */
export interface DowngradeConflict {
  resource: UsageWarning['resource'];
  used: number;
  limitAfter: number;
  /** Whether being over this line stops something, or only prompts an upgrade. */
  blocking: boolean;
  message: string;
}

/**
 * What a business would be over if it moved to `target`.
 *
 * A downgrade must never silently break an account, so this is surfaced by the
 * downgrade endpoint before anything is committed. Nothing is ever deleted by a
 * downgrade — the products, staff accounts and orders already there keep
 * working. What stops is ADDING more, so the wording says exactly that rather
 * than implying data is at risk.
 */
export function downgradeConflicts(usage: UsageSnapshot, target: BusinessPlan): DowngradeConflict[] {
  const limits = PLAN_LIMITS[target];
  const conflicts: DowngradeConflict[] = [];

  const add = (
    resource: DowngradeConflict['resource'],
    used: number,
    limitAfter: number,
    blocking: boolean,
    message: string,
  ): void => {
    if (limitAfter === UNLIMITED || used <= limitAfter) return;
    conflicts.push({ resource, used, limitAfter, blocking, message });
  };

  add(
    'products',
    usage.products.used,
    limits.products,
    true,
    `You have ${usage.products.used} products and this plan allows ${limits.products}. Every product stays exactly where it is, but you will not be able to add another until you are back under ${limits.products}.`,
  );

  add(
    'staff',
    usage.staff.used,
    limits.staff,
    true,
    `You have ${usage.staff.used} staff accounts and this plan allows ${limits.staff}. They all keep working, but you will not be able to invite anyone new until you deactivate ${usage.staff.used - limits.staff}.`,
  );

  add(
    'conversations',
    usage.conversations.used,
    limits.conversations,
    true,
    `You have already sent ${usage.conversations.used} conversations this month and this plan includes ${limits.conversations}. Automatic replies will be paused for the rest of the month the change takes effect in. Messages and orders still come in.`,
  );

  add(
    'orders',
    usage.orders.used,
    limits.orders,
    false,
    `You are taking more than the ${limits.orders} orders a month this plan includes. Orders are never blocked and nothing is lost — you will just see an upgrade prompt.`,
  );

  return conflicts;
}

/**
 * Whether an outbound auto-reply may be sent.
 *
 * At the conversation limit outbound messaging pauses, but inbound processing
 * continues — the owner keeps receiving orders, they just stop being answered
 * automatically until they upgrade.
 */
export async function canSendOutbound(businessId: string): Promise<boolean> {
  await refreshPlanState(businessId);

  const business = await loadPlanState(businessId);
  if (!business) return false;

  const active = effectivePlan(business);
  if (active === 'SUSPENDED') return false;

  const limit = PLAN_LIMITS[active].conversations;
  if (limit === UNLIMITED) return true;

  if (business.monthlyConvoCount >= limit) {
    logger.warn(
      { businessId, plan: active, used: business.monthlyConvoCount, limit },
      'Conversation limit reached — outbound auto-replies paused',
    );
    return false;
  }

  return true;
}

/** Records one outbound conversation against the monthly allowance. */
export async function recordOutboundConversation(businessId: string): Promise<void> {
  await prisma.business
    .update({
      where: { id: businessId },
      data: { monthlyConvoCount: { increment: 1 } },
    })
    .catch((error: unknown) => {
      // Usage accounting must never break message delivery.
      logger.error({ error, businessId }, 'Failed to record outbound conversation');
    });
}

/** Records one order against the monthly allowance. Orders are never blocked. */
export async function recordOrder(businessId: string): Promise<void> {
  await resetCountersIfDue(businessId);

  await prisma.business
    .update({
      where: { id: businessId },
      data: { monthlyOrderCount: { increment: 1 } },
    })
    .catch((error: unknown) => {
      logger.error({ error, businessId }, 'Failed to record order usage');
    });
}

export interface LimitCheck {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
}

async function checkCountLimit(
  businessId: string,
  key: keyof PlanLimits,
  used: number,
): Promise<LimitCheck> {
  // A downgrade that fell due since the last read must be in force before the
  // limit is applied, or the business would keep buying seats on a plan it no
  // longer holds.
  await applyDueScheduledChange(businessId);

  const business = await loadPlanState(businessId);

  if (!business) {
    return { allowed: false, limit: 0, used, remaining: 0 };
  }

  const limit = PLAN_LIMITS[effectivePlan(business)][key];
  const remaining = limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used);

  return { allowed: used < limit, limit, used, remaining };
}

export async function checkStaffLimit(businessId: string, current: number): Promise<LimitCheck> {
  return checkCountLimit(businessId, 'staff', current);
}

export async function checkProductLimit(businessId: string, current: number): Promise<LimitCheck> {
  return checkCountLimit(businessId, 'products', current);
}
