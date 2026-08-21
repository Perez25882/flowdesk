import { z } from 'zod';

export const PaymentMethodSchema = z.enum([
  'MOMO_MTN',
  'MOMO_VODAFONE',
  'MOMO_AIRTELTIGO',
  'CASH',
  'BANK_TRANSFER',
  'OTHER',
]);

export const PaymentDirectionSchema = z.enum(['IN', 'OUT']);
export const PaymentConfidenceSchema = z.enum([
  'CLAIMED',
  'SELLER_ATTESTED',
  'TELCO_MATCHED',
  'GATEWAY_CONFIRMED',
]);

export const CreatePaymentSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().optional(),
  // Bounded to keep a mistyped amount from corrupting a customer's balance.
  amount: z.coerce.number().positive().max(10_000_000),
  method: PaymentMethodSchema,
  /** OUT records a refund going back to the customer. */
  direction: PaymentDirectionSchema.default('IN'),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  /**
   * Owner-logged payments are money already in hand, so they are attested on
   * creation. Staff without the attest capability record a claim for review
   * instead — enforced in the route, not here.
   */
  attested: z.boolean().default(true),
});

/**
 * Confirming a claim: the owner reads the screenshot and states what it says.
 *
 * `amount` and `method` are required with no defaults. A claim recorded from a
 * screenshot carries a zero amount and a method of OTHER until a person supplies
 * the real ones, and defaulting either of them here would let a placeholder be
 * attested into the revenue figures with one tap.
 */
export const ConfirmPaymentSchema = z.object({
  amount: z.coerce.number().positive().max(10_000_000),
  method: PaymentMethodSchema,
  orderId: z.string().optional(),
  reference: z.string().max(200).optional(),
});

/** A void must say why. An unexplained reversal is not evidence of anything. */
export const VoidPaymentSchema = z.object({
  reason: z.string().min(3).max(500),
});

/**
 * A query-string boolean, parsed correctly.
 *
 * `z.coerce.boolean()` runs `Boolean(value)` under the hood, so the string
 * "false" — truthy as a string — coerces to `true`. That silently turns
 * `?attested=false` into `?attested=true` on the wire, which is exactly the
 * distinction the "needs checking" queries depend on. Parse the literal
 * strings instead.
 */
const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => (typeof value === 'string' ? value === 'true' : value));

export const ListPaymentsQuerySchema = z.object({
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  confidence: PaymentConfidenceSchema.optional(),
  attested: queryBooleanSchema.optional(),
  hasScreenshot: queryBooleanSchema.optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * The review queue is a working list, not an archive: an owner with hundreds of
 * unchecked claims has a different problem than pagination solves.
 */
export const ReviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;
export type ReviewQueueQueryInput = z.infer<typeof ReviewQueueQuerySchema>;
export type VoidPaymentInput = z.infer<typeof VoidPaymentSchema>;
export type ListPaymentsQueryInput = z.infer<typeof ListPaymentsQuerySchema>;
