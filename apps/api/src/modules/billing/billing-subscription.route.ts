import type { BusinessPlan } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { requireCapability, requireOwner } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import {
  comparePlans,
  downgradeConflicts,
  getUsage,
  trialState,
  usageWarnings,
  type UsageMeasure,
} from '../../services/plan/plan.service.js';
import {
  applyDueScheduledChange,
  claimSchedule,
  clearSchedule,
  readSchedule,
  updateSchedule,
  withChangeLock,
  type PlanChangeKind,
  type ScheduledPlanChange,
} from '../../services/billing/plan-schedule.js';
import {
  createSubscription,
  disableSubscription,
  enableSubscription,
  fetchSubscription,
  type PaystackSubscription,
} from '../../services/billing/paystack.js';
import {
  DowngradeRequestSchema,
  EndSubscriptionRequestSchema,
  PLAN_BILLING,
  paystackPlanCode,
  type PlanKey,
} from './billing.schema.js';

/**
 * Subscription management: what the plan is doing now, and how to change it.
 *
 * Until this existed the only billing endpoint was `POST /billing/checkout`, so
 * the Settings page's "Switch to this" opened a fresh Paystack transaction even
 * for a cheaper tier — charging a full month for a downgrade — and there was no
 * way at all to cancel or pause. Everything here is mounted under `/billing/`,
 * which `business-context.middleware.ts` keeps open after a trial lapses: an
 * owner who has run out of trial must be able to read what they owe and act on
 * it, which is the whole point of the screen.
 *
 * MONEY, IN ONE PLACE
 *
 * Paystack has no proration and no "move this subscription to another plan"
 * call. So:
 *
 *   Upgrade    charges the new plan in full today and starts a new monthly
 *              cycle from today. The remainder of the current period is not
 *              refunded or credited — Paystack will not honour a credit we
 *              invent, and pretending otherwise in the UI would be a lie the
 *              customer's bank statement contradicts. Handled by
 *              `POST /billing/checkout`.
 *   Downgrade  changes nothing today. The current subscription is stopped so it
 *              cannot bill again at the higher price, and the cheaper plan is
 *              scheduled to begin the day the paid period ends. No money moves
 *              until then, and the customer keeps every feature they paid for
 *              in the meantime.
 *   Cancel     stops the subscription renewing. The plan runs to the end of the
 *              paid period and then lapses. No refund, no immediate cut-off.
 *   Pause      is cancel with its intent recorded, so `POST /billing/resume`
 *              can put the subscription straight back before the period ends,
 *              or offer the same plan back afterwards.
 *
 * Nothing here bills anybody. Every path either stops a future charge or moves
 * a date; the only charge Flowdesk ever initiates is a checkout the owner
 * completed on Paystack's own page.
 */

interface LimitDto {
  used: number;
  /** Null means the plan sets no ceiling. */
  limit: number | null;
  remaining: number | null;
  nearLimit: boolean;
  overLimit: boolean;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

/**
 * `Infinity` survives neither `JSON.stringify` nor a reader's expectations — it
 * arrives at the browser as `null` by accident. Mapped deliberately instead, so
 * "no ceiling" is a documented value rather than a serialisation artefact.
 */
function toLimitDto(measure: UsageMeasure): LimitDto {
  return {
    used: measure.used,
    limit: measure.limit === UNLIMITED ? null : measure.limit,
    remaining: measure.remaining === UNLIMITED ? null : measure.remaining,
    nearLimit: measure.nearLimit,
    overLimit: measure.overLimit,
  };
}

function scheduleDto(change: ScheduledPlanChange | null): Record<string, unknown> | null {
  if (!change) return null;

  return {
    kind: change.kind,
    targetPlan: change.targetPlan,
    previousPlan: change.previousPlan,
    effectiveAt: change.effectiveAt,
    requiresCheckout: change.requiresCheckout,
    appliedAt: change.appliedAt,
  };
}

function planLabel(plan: BusinessPlan): string {
  const billing = PLAN_BILLING[plan as PlanKey];
  return billing ? billing.label : plan.charAt(0) + plan.slice(1).toLowerCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function refuse(reply: FastifyReply, status: number, code: string, error: string): FastifyReply {
  return reply.status(status).send({ success: false, error, code });
}

/**
 * Runs a plan change under this business's billing lock.
 *
 * The two ways a change can fail before it has begun get their own answers,
 * because they mean different things to the owner: someone (or something) is
 * already changing this plan, or we could not take the lock at all and have
 * therefore touched nothing.
 */
async function runBillingChange(
  reply: FastifyReply,
  businessId: string,
  work: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  const result = await withChangeLock(businessId, work);

  if (result.ok) return result.value;

  if (result.reason === 'held') {
    return refuse(
      reply,
      409,
      'CHANGE_IN_PROGRESS',
      'Another billing change is being processed. Please try again in a moment.',
    );
  }

  return refuse(
    reply,
    503,
    'BILLING_UNAVAILABLE',
    'We could not record this change safely, so nothing was altered. Please try again shortly.',
  );
}

/**
 * Loads the live subscription a change is about to act on.
 *
 * Returns the reason it cannot be acted on rather than throwing, because each
 * one is a different sentence for the owner: a subscription Paystack cannot be
 * reached about is "try again shortly", while one with no next payment date has
 * already stopped and has nothing left to schedule against.
 */
async function loadChangeableSubscription(
  code: string,
): Promise<{ subscription: PaystackSubscription } | { refusal: { status: number; code: string; error: string } }> {
  const subscription = await fetchSubscription(code).catch((error: unknown) => {
    logger.error({ error, code }, 'Paystack subscription lookup failed');
    return null;
  });

  if (!subscription) {
    return {
      refusal: {
        status: 502,
        code: 'PAYSTACK_UNAVAILABLE',
        error: 'We could not reach Paystack to read your subscription. Please try again shortly.',
      },
    };
  }

  if (!subscription.nextPaymentDate) {
    return {
      refusal: {
        status: 409,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        error: `Your subscription is ${subscription.status} and has no next payment date, so there is nothing left to schedule.`,
      },
    };
  }

  return { subscription };
}

/**
 * Stops the current subscription and records what should happen when the paid
 * period ends. Shared by downgrade, cancel and pause, which differ only in what
 * the business becomes and what it is told.
 *
 * ORDER OF OPERATIONS MATTERS, TWICE OVER
 *
 * The schedule is written BEFORE Paystack is told to stop the subscription.
 * Disabling makes Paystack fire `subscription.not_renew` immediately, and the
 * webhook treats a subscription ending with no schedule behind it as a failed
 * payment — so a delivery that beat our own write would start a 3-day countdown
 * to suspension on a customer who had merely downgraded. Writing first closes
 * that race; if the disable then fails, the schedule is rolled back and nothing
 * has changed anywhere.
 *
 * The replacement subscription is created AFTER the old one is disabled. The
 * other order risks a customer holding two live subscriptions if the disable
 * fails, and being charged twice. This order risks only that the cheaper plan
 * has no automatic payment behind it, which the response says out loud and the
 * owner fixes with one checkout. Under-billing is recoverable; double-billing
 * is a refund and an apology.
 */
async function scheduleChange(options: {
  businessId: string;
  kind: PlanChangeKind;
  currentPlan: BusinessPlan;
  targetPlan: BusinessPlan;
  subscription: PaystackSubscription;
  customerCode: string | null;
}): Promise<{ change: ScheduledPlanChange } | { refusal: { status: number; code: string; error: string } }> {
  const { businessId, kind, currentPlan, targetPlan, subscription } = options;

  const change: ScheduledPlanChange = {
    businessId,
    kind,
    targetPlan,
    effectiveAt: new Date(subscription.nextPaymentDate as string).toISOString(),
    previousPlan: currentPlan,
    subscriptionCode: subscription.subscriptionCode,
    replacementSubscriptionCode: null,
    // Pessimistic until Paystack accepts a replacement, so a lost update leaves
    // the owner asked to pay by hand rather than expecting a charge that never
    // comes.
    requiresCheckout: true,
    appliedAt: null,
  };

  let claimed: boolean;

  try {
    claimed = await claimSchedule(change);
  } catch (error: unknown) {
    // Redis refused the record. Stop here: changing the subscription at
    // Paystack with nothing recorded is how a customer ends up cancelled with
    // no explanation and no way back.
    logger.error({ error, businessId, kind }, 'Could not record plan change — Paystack not touched');
    return {
      refusal: {
        status: 503,
        code: 'BILLING_UNAVAILABLE',
        error: 'We could not record this change safely, so nothing was altered. Please try again shortly.',
      },
    };
  }

  if (!claimed) {
    return {
      refusal: {
        status: 409,
        code: 'CHANGE_ALREADY_SCHEDULED',
        error: 'A plan change is already scheduled. Resume your plan first if you want to choose something else.',
      },
    };
  }

  const disabled = await disableSubscription(
    subscription.subscriptionCode,
    subscription.emailToken,
  );

  if (!disabled) {
    await clearSchedule(businessId);
    return {
      refusal: {
        status: 502,
        code: 'PAYSTACK_UNAVAILABLE',
        error: 'Paystack would not stop the subscription, so nothing was changed. Please try again shortly.',
      },
    };
  }

  if (targetPlan !== 'SUSPENDED') {
    const planCode = paystackPlanCode(targetPlan as PlanKey);
    const customer = options.customerCode ?? subscription.customerCode;

    if (planCode && customer) {
      const replacement = await createSubscription({
        customer,
        plan: planCode,
        ...(subscription.authorizationCode
          ? { authorization: subscription.authorizationCode }
          : {}),
        startDate: change.effectiveAt,
      });

      if (replacement) {
        change.replacementSubscriptionCode = replacement.subscriptionCode;
        change.requiresCheckout = false;
      } else {
        logger.warn(
          { businessId, targetPlan },
          'No deferred subscription for downgrade — owner must check out on the effective date',
        );
      }
    }
  }

  await updateSchedule(change);

  logger.info(
    { businessId, kind, targetPlan, effectiveAt: change.effectiveAt },
    'Plan change scheduled for the end of the paid period',
  );

  return { change };
}

export default async function billingSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /billing/state
   *
   * Everything the dashboard needs on load: the plan in force, the trial
   * countdown and which of PRD 3.10's warnings to show, the usage figures with
   * their 90%-and-over warnings, and any change already scheduled.
   *
   * One endpoint rather than three because all of it is read at once when a
   * screen mounts, and because the 90% warning was already being computed and
   * then dropped for want of somewhere to put it.
   */
  app.get(
    '/billing/state',
    { preHandler: requireCapability('settings.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const businessId = request.business!.id;

      // Reads through `getUsage`, which applies any change that has fallen due
      // before reporting — so the figures below are the ones being enforced.
      const usage = await getUsage(businessId);

      if (!usage) {
        return refuse(reply, 404, 'NOT_FOUND', 'Business not found');
      }

      const [business, schedule] = await Promise.all([
        prisma.business.findUnique({
          where: { id: businessId },
          select: { trialEndsAt: true, paystackSubCode: true, suspendReason: true },
        }),
        readSchedule(businessId),
      ]);

      const trial = trialState({
        trialEndsAt: business?.trialEndsAt ?? null,
        paystackSubCode: business?.paystackSubCode ?? null,
      });

      return success(reply, {
        plan: usage.plan,
        effectivePlan: usage.effectivePlan,
        planLabel: planLabel(usage.effectivePlan),
        suspended: usage.suspended,
        suspendReason: business?.suspendReason ?? null,
        trial: {
          active: trial.active,
          stage: trial.stage,
          daysRemaining: trial.daysRemaining,
          endsAt: trial.endsAt?.toISOString() ?? null,
          graceEndsAt: trial.graceEndsAt?.toISOString() ?? null,
        },
        subscription: business?.paystackSubCode
          ? { code: business.paystackSubCode, amountMinor: PLAN_BILLING[usage.plan as PlanKey]?.amountMinor ?? null }
          : null,
        scheduledChange: scheduleDto(schedule),
        usage: {
          periodEndsAt: usage.periodEndsAt?.toISOString() ?? null,
          conversations: toLimitDto(usage.conversations),
          orders: toLimitDto(usage.orders),
          staff: toLimitDto(usage.staff),
          products: toLimitDto(usage.products),
        },
        warnings: usageWarnings(usage),
      });
    },
  );

  /**
   * POST /billing/downgrade
   *
   * Two-step by design. Called without `confirm` it is a preview: it reports
   * when the change would take effect and what the business is already over on,
   * and touches nothing. Called with `confirm: true` it commits.
   *
   * Charging someone for Growth and handing them Starter the same afternoon is
   * theft, so the change always lands at the end of the period they have paid
   * for — never today.
   */
  app.post(
    '/billing/downgrade',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = DowngradeRequestSchema.parse(request.body);
      const business = request.business!;
      const target: BusinessPlan = body.plan;

      if (comparePlans(target, business.plan) >= 0) {
        return refuse(
          reply,
          400,
          'NOT_A_DOWNGRADE',
          `${planLabel(target)} is not below your current ${planLabel(business.plan)} plan. Use /billing/checkout to move up.`,
        );
      }

      if (!business.paystackSubCode) {
        return refuse(
          reply,
          409,
          'NO_ACTIVE_SUBSCRIPTION',
          'There is no subscription to change. Choose the plan you want at checkout instead.',
        );
      }

      const loaded = await loadChangeableSubscription(business.paystackSubCode);

      if ('refusal' in loaded) {
        return refuse(reply, loaded.refusal.status, loaded.refusal.code, loaded.refusal.error);
      }

      const effectiveAt = new Date(loaded.subscription.nextPaymentDate as string).toISOString();
      const usage = await getUsage(business.id);
      const conflicts = usage ? downgradeConflicts(usage, target) : [];

      if (conflicts.length > 0 && body.confirm !== true) {
        return success(reply, {
          scheduled: false,
          requiresConfirmation: true,
          kind: 'downgrade',
          currentPlan: business.plan,
          targetPlan: target,
          effectiveAt,
          amountMinorAtRenewal: PLAN_BILLING[target as PlanKey]?.amountMinor ?? null,
          requiresCheckout: false,
          conflicts,
          message: `Nothing changes before ${formatDate(effectiveAt)}. Read what is over the line below, then send the same request with "confirm": true.`,
        });
      }

      return runBillingChange(reply, business.id, async () => {
        const scheduled = await scheduleChange({
          businessId: business.id,
          kind: 'downgrade',
          currentPlan: business.plan,
          targetPlan: target,
          subscription: loaded.subscription,
          customerCode: business.paystackCustomerId,
        });

        if ('refusal' in scheduled) {
          return refuse(
            reply,
            scheduled.refusal.status,
            scheduled.refusal.code,
            scheduled.refusal.error,
          );
        }

        const { change } = scheduled;

        return success(reply, {
          scheduled: true,
          requiresConfirmation: false,
          kind: 'downgrade',
          currentPlan: business.plan,
          targetPlan: target,
          effectiveAt: change.effectiveAt,
          amountMinorAtRenewal: PLAN_BILLING[target as PlanKey]?.amountMinor ?? null,
          requiresCheckout: change.requiresCheckout,
          conflicts,
          message: change.requiresCheckout
            ? `You keep ${planLabel(business.plan)} until ${formatDate(change.effectiveAt)}, and you will not be charged for it again. We could not set up automatic payment for ${planLabel(target)}, so we will ask you to pay for it on the day.`
            : `You keep ${planLabel(business.plan)} until ${formatDate(change.effectiveAt)}. From then you are on ${planLabel(target)} and pay its price instead. You are not charged anything today.`,
        });
      });
    },
  );

  /**
   * POST /billing/cancel
   *
   * Stops the subscription renewing and lets the plan run to the end of the
   * period already paid for, then lapse — not an immediate cut-off. What lapsing
   * means is in `plan-schedule.ts`: every limit goes to zero, the account is
   * readable, and billing stays reachable so coming back is one payment.
   */
  app.post(
    '/billing/cancel',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return endSubscription(request, reply, 'cancel');
    },
  );

  /**
   * POST /billing/pause
   *
   * The PRD names pausing as the answer to price-sensitive churn: an owner
   * whose slow season is two months should not have to cancel and lose the
   * thread. Mechanically identical to cancelling — Paystack has no pause — but
   * it records the plan being left so `/billing/resume` can offer it straight
   * back, and before the period ends resume is free and instant.
   */
  app.post(
    '/billing/pause',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return endSubscription(request, reply, 'pause');
    },
  );

  async function endSubscription(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'cancel' | 'pause',
  ): Promise<FastifyReply> {
    const body = EndSubscriptionRequestSchema.parse(request.body ?? {});
    const business = request.business!;

    if (!business.paystackSubCode) {
      return refuse(
        reply,
        409,
        'NO_ACTIVE_SUBSCRIPTION',
        'There is no subscription to stop.',
      );
    }

    const loaded = await loadChangeableSubscription(business.paystackSubCode);

    if ('refusal' in loaded) {
      return refuse(reply, loaded.refusal.status, loaded.refusal.code, loaded.refusal.error);
    }

    return runBillingChange(reply, business.id, async () => {
      const scheduled = await scheduleChange({
        businessId: business.id,
        kind,
        currentPlan: business.plan,
        targetPlan: 'SUSPENDED',
        subscription: loaded.subscription,
        customerCode: business.paystackCustomerId,
      });

      if ('refusal' in scheduled) {
        return refuse(
          reply,
          scheduled.refusal.status,
          scheduled.refusal.code,
          scheduled.refusal.error,
        );
      }

      const { change } = scheduled;

      if (body.reason) {
        logger.info({ businessId: business.id, kind, reason: body.reason }, 'Subscription ended by owner');
      }

      return success(reply, {
        scheduled: true,
        kind,
        currentPlan: business.plan,
        accessUntil: change.effectiveAt,
        effectiveAt: change.effectiveAt,
        resumable: true,
        message:
          kind === 'pause'
            ? `Your ${planLabel(business.plan)} plan is paused. Everything keeps working until ${formatDate(change.effectiveAt)} — you have paid for it — and you can pick it back up at any time.`
            : `Your ${planLabel(business.plan)} plan will not renew. Everything keeps working until ${formatDate(change.effectiveAt)}, then the account goes read-only. Nothing is deleted.`,
      });
    });
  }

  /**
   * POST /billing/resume
   *
   * Undoes a pause, a cancellation or a downgrade that has not taken effect
   * yet, by putting the original subscription back on its schedule. Once the
   * period has ended there is nothing left to re-enable, so this reports which
   * plan to check out on instead rather than pretending to have resumed.
   */
  app.post(
    '/billing/resume',
    { preHandler: requireOwner },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const business = request.business!;

      return runBillingChange(reply, business.id, async () => {
        // Anything that fell due while the owner was deciding is applied first,
        // so we never re-enable a subscription whose period has already closed.
        await applyDueScheduledChange(business.id);

        const change = await readSchedule(business.id);

        if (!change) {
          return success(reply, {
            resumed: false,
            requiresCheckout: !business.paystackSubCode,
            plan: business.plan,
            message: business.paystackSubCode
              ? 'Your plan is already running — there is nothing to resume.'
              : 'There is no paused plan to resume. Choose a plan at checkout.',
          });
        }

        if (change.appliedAt) {
          return success(reply, {
            resumed: false,
            requiresCheckout: true,
            plan: change.previousPlan,
            message: `Your ${planLabel(change.previousPlan)} plan ended on ${formatDate(change.effectiveAt)}. Pay for it again and everything comes straight back — nothing was deleted.`,
          });
        }

        if (!change.subscriptionCode) {
          return refuse(
            reply,
            409,
            'NO_ACTIVE_SUBSCRIPTION',
            'There is no subscription to put back. Choose a plan at checkout.',
          );
        }

        const subscription = await fetchSubscription(change.subscriptionCode).catch(
          (error: unknown) => {
            logger.error({ error, businessId: business.id }, 'Paystack subscription lookup failed');
            return null;
          },
        );

        if (!subscription) {
          return refuse(
            reply,
            502,
            'PAYSTACK_UNAVAILABLE',
            'We could not reach Paystack to restore your subscription. Please try again shortly.',
          );
        }

        // A downgrade may have left a cheaper subscription waiting to start.
        // It has to go before the original is re-enabled, or the customer ends
        // up paying for both from the same date.
        if (change.replacementSubscriptionCode) {
          const replacement = await fetchSubscription(change.replacementSubscriptionCode).catch(
            () => null,
          );

          const removed = replacement
            ? await disableSubscription(replacement.subscriptionCode, replacement.emailToken)
            : false;

          if (!removed) {
            return refuse(
              reply,
              502,
              'PAYSTACK_UNAVAILABLE',
              'We could not remove the queued plan change, so your plan was left exactly as it is. Please try again shortly.',
            );
          }
        }

        const enabled = await enableSubscription(
          subscription.subscriptionCode,
          subscription.emailToken,
        );

        if (!enabled) {
          return refuse(
            reply,
            502,
            'PAYSTACK_UNAVAILABLE',
            'Paystack would not restart the subscription. Please try again shortly.',
          );
        }

        await clearSchedule(business.id);

        logger.info({ businessId: business.id, kind: change.kind }, 'Scheduled plan change reversed');

        return success(reply, {
          resumed: true,
          requiresCheckout: false,
          plan: business.plan,
          nextPaymentDate: subscription.nextPaymentDate,
          message: `Your ${planLabel(business.plan)} plan is running again. The next payment is on ${formatDate(change.effectiveAt)} as before.`,
        });
      });
    },
  );
}
