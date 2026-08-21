import type { BusinessPlan } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';

/**
 * Plan changes that take effect later.
 *
 * Three things need "not now, then": a downgrade (which must not cut someone's
 * features on a day they have already paid for), a cancellation or pause
 * (which runs to the end of the paid period and then lapses), and the 3-day
 * grace the PRD gives a failed payment before the account stops.
 *
 * WHERE THIS LIVES, AND WHAT HAPPENS IF IT IS LOST
 *
 * `Business` has no column for "this becomes a Starter plan on 12 September",
 * so the record is held in Redis. Two properties make that safe enough to bill
 * against:
 *
 *   - The TTL is far longer than any period it describes, so a record can never
 *     expire *before* its own effective date and quietly cancel a change that
 *     was owed. It either applies or it is still sitting there.
 *   - Applying it is a write of fixed values to Postgres, so applying it twice
 *     is the same as applying it once, and the record is kept (marked applied)
 *     rather than deleted.
 *
 * If Redis is lost outright, pending changes are forgotten. That fails in the
 * customer's favour in every case: a scheduled downgrade or cancellation stops
 * being applied, so the business keeps the plan it is on; a payment-failure
 * grace stops being applied, so nothing is suspended. Nobody is cut off or
 * billed by a record that vanished — but somebody may keep service they have
 * stopped paying for until support notices. Writing the schedule is therefore
 * treated as part of the money path: if Redis will not take the record we do
 * not touch the subscription at Paystack at all, so the two never disagree.
 *
 * The durable fix is two columns on `Business` — see the billing report.
 */

const PREFIX = 'flowdesk:billing:schedule:';
const LOCK_PREFIX = 'flowdesk:billing:change-lock:';

/**
 * Comfortably longer than a monthly period plus the longest grace, so the
 * record cannot lapse before the date it describes.
 */
const TTL_SECONDS = 60 * 24 * 60 * 60;

/** Serialises two plan changes for one business; released as soon as one wins. */
const LOCK_TTL_SECONDS = 60;

/** PRD 3.10: "Failed payment: 3-day grace period → suspension". */
export const PAYMENT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type PlanChangeKind = 'downgrade' | 'cancel' | 'pause' | 'payment_failed';

export interface ScheduledPlanChange {
  businessId: string;
  kind: PlanChangeKind;
  /** What the business becomes at `effectiveAt`. SUSPENDED means it lapses. */
  targetPlan: BusinessPlan;
  /** ISO. The end of the period the customer has already paid for. */
  effectiveAt: string;
  /** The plan in force when the change was scheduled — what a pause restores. */
  previousPlan: BusinessPlan;
  /** The Paystack subscription this was scheduled against. */
  subscriptionCode: string | null;
  /** The subscription that takes over at `effectiveAt`, where we could make one. */
  replacementSubscriptionCode: string | null;
  /** True when no replacement exists and the owner must check out to keep paying. */
  requiresCheckout: boolean;
  /** ISO once written through to the business row; null while still pending. */
  appliedAt: string | null;
}

function keyFor(businessId: string): string {
  return `${PREFIX}${businessId}`;
}

/**
 * Reads the schedule, or null when there is none.
 *
 * A Redis failure reads as "no schedule". Every caller either applies a change
 * (which then simply does not happen yet) or reports state, and neither should
 * fail a request because the cache is briefly unreachable.
 */
export async function readSchedule(businessId: string): Promise<ScheduledPlanChange | null> {
  try {
    const raw = await redis.get(keyFor(businessId));
    if (!raw) return null;
    return JSON.parse(raw) as ScheduledPlanChange;
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Failed to read scheduled plan change');
    return null;
  }
}

/**
 * Writes a schedule unless one is already pending.
 *
 * Returns false when a pending change already exists, so a double-clicked
 * "Cancel my plan" cannot disable the subscription twice, and a webhook that
 * arrives while we are still writing cannot start a second, contradictory
 * change. An already-applied record is replaced: it is history, not a claim.
 *
 * Throws when Redis is unreachable. That is deliberate — the caller is about to
 * change a subscription at Paystack, and doing that without a record of what it
 * was for is how a customer ends up cancelled with nothing to explain it.
 */
export async function claimSchedule(change: ScheduledPlanChange): Promise<boolean> {
  const existing = await redis.get(keyFor(change.businessId));

  if (existing) {
    const pending = JSON.parse(existing) as ScheduledPlanChange;
    if (!pending.appliedAt) return false;
  }

  await redis.set(keyFor(change.businessId), JSON.stringify(change), 'EX', TTL_SECONDS);
  return true;
}

/** Overwrites an existing schedule — used to record what Paystack accepted. */
export async function updateSchedule(change: ScheduledPlanChange): Promise<void> {
  try {
    await redis.set(keyFor(change.businessId), JSON.stringify(change), 'EX', TTL_SECONDS);
  } catch (error: unknown) {
    // The claimed record stands. It is written pessimistically (no replacement
    // subscription, checkout required), so losing this update costs the
    // customer nothing — at worst they are asked to pay by hand for a renewal
    // we had in fact automated.
    logger.error({ error, businessId: change.businessId }, 'Failed to update scheduled plan change');
  }
}

/** Drops the schedule entirely — the change was called off before it applied. */
export async function clearSchedule(businessId: string): Promise<void> {
  try {
    await redis.del(keyFor(businessId));
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Failed to clear scheduled plan change');
  }
}

/** Either the work ran, or the reason it could not even be attempted. */
export type ChangeLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'held' | 'unavailable' };

/**
 * Runs `work` with an exclusive claim on this business's billing state.
 *
 * Every plan change reads Paystack, writes a schedule and then calls Paystack
 * again. Two of those interleaved would disable one subscription twice or
 * create two replacements, so they are serialised. A lock already held comes
 * back as `held` rather than waiting, because the holder is mid-way through a
 * multi-second conversation with Paystack.
 *
 * `unavailable` means Redis would not give us the lock at all. That is reported
 * separately from a failure inside `work`, so the caller can say "nothing was
 * changed" and be telling the truth.
 */
export async function withChangeLock<T>(
  businessId: string,
  work: () => Promise<T>,
): Promise<ChangeLockResult<T>> {
  const key = `${LOCK_PREFIX}${businessId}`;
  let acquired: string | null;

  try {
    acquired = await redis.set(key, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  } catch (error: unknown) {
    logger.error({ error, businessId }, 'Could not take the billing change lock');
    return { ok: false, reason: 'unavailable' };
  }

  if (acquired !== 'OK') return { ok: false, reason: 'held' };

  try {
    return { ok: true, value: await work() };
  } finally {
    await redis.del(key).catch((error: unknown) => {
      // The TTL clears it either way; the business is briefly unable to make a
      // second change, which is the safe direction to fail in.
      logger.warn({ error, businessId }, 'Failed to release billing change lock');
    });
  }
}

/** Plain-English record of why a business stopped, for support and for the owner. */
function lapseReason(change: ScheduledPlanChange): string {
  const was = change.previousPlan;

  if (change.kind === 'payment_failed') {
    return `Payment failed and the 3-day grace period passed. Your ${was} plan is on hold — pay to pick it straight back up.`;
  }

  if (change.kind === 'pause') {
    return `Plan paused. Your ${was} plan and all your data are waiting whenever you want to start again.`;
  }

  return `Subscription cancelled. Your ${was} plan ran to the end of the period you had paid for.`;
}

/**
 * Writes a due change through to the business row.
 *
 * Called from the plan service on every plan read, which is what stands in for
 * the scheduler this service does not have.
 *
 * A lapse is recorded as `plan = SUSPENDED` rather than by stamping
 * `suspendedAt`. Both stop the account, but `suspendedAt` is a flat 403 on the
 * whole API in `business-context.middleware.ts` — including `/billing/`, which
 * is the one door the customer needs to walk back through to pay. Writing the
 * plan instead zeroes every limit through `PLAN_LIMITS.SUSPENDED` while leaving
 * the account read-only with billing reachable, which is what the landing page
 * promises and what lets somebody resubscribe without emailing support.
 */
export async function applyDueScheduledChange(businessId: string): Promise<void> {
  const change = await readSchedule(businessId);

  if (!change || change.appliedAt) return;
  if (new Date(change.effectiveAt).getTime() > Date.now()) return;

  const data =
    change.targetPlan === 'SUSPENDED'
      ? {
          plan: 'SUSPENDED' as BusinessPlan,
          paystackSubCode: null,
          suspendReason: lapseReason(change),
        }
      : {
          plan: change.targetPlan,
          paystackSubCode: change.replacementSubscriptionCode,
          suspendReason: null,
        };

  try {
    await prisma.business.update({ where: { id: businessId }, data });
  } catch (error: unknown) {
    // Leave the record pending so the next read tries again, rather than
    // marking a change applied that never reached the database.
    logger.error({ error, businessId, kind: change.kind }, 'Failed to apply scheduled plan change');
    return;
  }

  await updateSchedule({ ...change, appliedAt: new Date().toISOString() });

  logger.info(
    { businessId, kind: change.kind, targetPlan: change.targetPlan },
    'Scheduled plan change applied',
  );
}

/**
 * Starts the PRD's 3-day grace after a failed renewal.
 *
 * Paystack does not retry a failed subscription charge, so the failure event is
 * the whole story — but cutting the shop off the same afternoon its card
 * expired is not what was promised, and it is a terrible way to treat somebody
 * who is about to fix it. Returns false when a change is already scheduled, in
 * which case this "failure" is the expected end of a cancellation or downgrade
 * we asked for and must not be turned into a suspension.
 */
export async function startPaymentGrace(
  businessId: string,
  currentPlan: BusinessPlan,
  subscriptionCode: string | null,
): Promise<boolean> {
  const claimed = await claimSchedule({
    businessId,
    kind: 'payment_failed',
    targetPlan: 'SUSPENDED',
    effectiveAt: new Date(Date.now() + PAYMENT_GRACE_MS).toISOString(),
    previousPlan: currentPlan,
    subscriptionCode,
    replacementSubscriptionCode: null,
    requiresCheckout: true,
    appliedAt: null,
  });

  if (claimed) {
    logger.warn(
      { businessId, subscriptionCode },
      'Subscription payment failed — 3-day grace period started',
    );
  }

  return claimed;
}
