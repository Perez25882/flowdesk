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

export const CheckoutRequestSchema = z
  .object({
    plan: PlanKeySchema,
  })
  .strict();

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
