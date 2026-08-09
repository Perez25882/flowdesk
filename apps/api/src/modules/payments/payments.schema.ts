import { z } from 'zod';

export const PaymentMethodSchema = z.enum([
  'MOMO_MTN',
  'MOMO_VODAFONE',
  'MOMO_AIRTELTIGO',
  'CASH',
  'BANK_TRANSFER',
  'OTHER',
]);

export const CreatePaymentSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().optional(),
  // Bounded to keep a mistyped amount from corrupting a customer's balance.
  amount: z.coerce.number().positive().max(10_000_000),
  method: PaymentMethodSchema,
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  /**
   * Owner-logged payments are money already received, so they count immediately.
   * The screenshot review flow passes `false` to stage a payment for approval.
   */
  verified: z.boolean().default(true),
});

export const VerifyPaymentSchema = z.object({
  verified: z.boolean().default(true),
});

export const ListPaymentsQuerySchema = z.object({
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  verified: z.coerce.boolean().optional(),
  hasScreenshot: z.coerce.boolean().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type VerifyPaymentInput = z.infer<typeof VerifyPaymentSchema>;
export type ListPaymentsQueryInput = z.infer<typeof ListPaymentsQuerySchema>;
