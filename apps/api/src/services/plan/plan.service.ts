import type { BusinessPlan } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

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
  /** Outbound conversation allowance per calendar month. */
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
const TRIAL_GRACE_MS = 48 * 60 * 60 * 1000;

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
 * The plan actually in force.
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

  const hasSubscription = Boolean(business.paystackSubCode);
  if (hasSubscription) return business.plan;

  if (business.trialEndsAt) {
    const graceEnds = new Date(business.trialEndsAt.getTime() + TRIAL_GRACE_MS);
    if (graceEnds < new Date()) return 'SUSPENDED';
  }

  return business.plan;
}

export interface UsageSnapshot {
  plan: BusinessPlan;
  effectivePlan: BusinessPlan;
  conversations: { used: number; limit: number; remaining: number; nearLimit: boolean };
  orders: { used: number; limit: number; remaining: number; nearLimit: boolean };
  staff: { used: number; limit: number; remaining: number; nearLimit: boolean };
  products: { used: number; limit: number; remaining: number; nearLimit: boolean };
  trialEndsAt: Date | null;
  suspended: boolean;
}

function measure(used: number, limit: number) {
  const remaining = limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    nearLimit: limit !== UNLIMITED && limit > 0 && used / limit >= WARNING_THRESHOLD,
  };
}

/** Full usage picture for the billing/settings screens. */
export async function getUsage(businessId: string): Promise<UsageSnapshot | null> {
  await resetCountersIfDue(businessId);

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
    trialEndsAt: business.trialEndsAt,
    suspended: active === 'SUSPENDED',
  };
}

/**
 * Whether an outbound auto-reply may be sent.
 *
 * At the conversation limit outbound messaging pauses, but inbound processing
 * continues — the owner keeps receiving orders, they just stop being answered
 * automatically until they upgrade.
 */
export async function canSendOutbound(businessId: string): Promise<boolean> {
  await resetCountersIfDue(businessId);

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
