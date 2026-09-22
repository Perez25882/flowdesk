import { z } from 'zod';

export const PlanKeySchema = z.enum(['STARTER', 'BUSINESS', 'GROWTH']);
export type PlanKey = z.infer<typeof PlanKeySchema>;

/**
 * Paystack plan codes for each Flowdesk tier. The single source of truth for
 * the amount-of-money side of plan upgrades — anything that needs to compute
 * a bill looks here, not at the unit map in the UI.
 *
 * If you change these, also update the corresponding Paystack dashboard plans.
 */
export const PLAN_BILLING: Record<PlanKey, { label: string; amountMinor: number; interval: 'monthly' }> = {
  STARTER: { label: 'Starter', amountMinor: 150_00, interval: 'monthly' },
  BUSINESS: { label: 'Business', amountMinor: 350_00, interval: 'monthly' },
  GROWTH: { label: 'Growth', amountMinor: 700_00, interval: 'monthly' },
};

/** Environment variable holding each tier's Paystack plan code. */
const PLAN_CODE_ENV: Record<PlanKey, string> = {
  STARTER: 'PAYSTACK_PLAN_STARTER',
  BUSINESS: 'PAYSTACK_PLAN_BUSINESS',
  GROWTH: 'PAYSTACK_PLAN_GROWTH',
};

/**
 * The Paystack plan code a checkout should subscribe the customer to.
 *
 * A transaction initialised WITHOUT a plan code is a one-off charge: Paystack
 * creates no subscription, `charge.success` carries no `subscription_code`, and
 * `paystackSubCode` stays null. That is why a customer who had paid was still
 * treated as a lapsed trial once their 48-hour grace ran out, and why cancel,
 * pause and downgrade had nothing to act on — there was never a subscription to
 * act on. Passing the plan code is what turns the payment into a recurring one.
 *
 * Read from the environment on each call rather than at import, so a deployment
 * can add the codes without a restart and so tests can exercise both paths.
 * When a code is absent the checkout still works and still charges the right
 * amount; it simply produces a single payment with no subscription behind it,
 * which is exactly the behaviour that existed before.
 */
export function paystackPlanCode(plan: PlanKey): string | undefined {
  const value = process.env[PLAN_CODE_ENV[plan]];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export const CheckoutRequestSchema = z
  .object({
    plan: PlanKeySchema,
  })
  .strict();

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

/**
 * A move to a cheaper tier.
 *
 * `confirm` exists because a downgrade can leave a business over the lower
 * plan's ceilings. The first call is a preview: it reports what will be over
 * the line and changes nothing. The second, with `confirm: true`, commits.
 */
export const DowngradeRequestSchema = z
  .object({
    plan: PlanKeySchema,
    confirm: z.boolean().optional(),
  })
  .strict();

export type DowngradeRequest = z.infer<typeof DowngradeRequestSchema>;

/** Cancelling and pausing take the same optional note, kept for support. */
export const EndSubscriptionRequestSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type EndSubscriptionRequest = z.infer<typeof EndSubscriptionRequestSchema>;
