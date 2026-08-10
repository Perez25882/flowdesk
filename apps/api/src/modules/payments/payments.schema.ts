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

/** A void must say why. An unexplained reversal is not evidence of anything. */
export const VoidPaymentSchema = z.object({
  reason: z.string().min(3).max(500),
});

export const ListPaymentsQuerySchema = z.object({
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  confidence: PaymentConfidenceSchema.optional(),
  attested: z.coerce.boolean().optional(),
  hasScreenshot: z.coerce.boolean().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type VoidPaymentInput = z.infer<typeof VoidPaymentSchema>;
export type ListPaymentsQueryInput = z.infer<typeof ListPaymentsQuerySchema>;
