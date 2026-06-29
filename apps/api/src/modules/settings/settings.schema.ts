import { z } from 'zod';

export const ReplyTemplatesSchema = z
  .record(z.string().min(1), z.string().min(1))
  .nullable();

export const ReplyTemplateKeySchema = z.enum([
  'orderReceived',
  'orderConfirmed',
  'orderReady',
  'orderCancelled',
  'paymentReceived',
  'paymentPartial',
  'lowStock',
  'greeting',
  'thanks',
  'unknown',
]);

/** Friendly defaults — surfaced to the UI as suggestions when replyTemplates is null. */
export const REPLY_TEMPLATE_DEFAULTS: Record<z.infer<typeof ReplyTemplateKeySchema>, string> = {
  orderReceived:
    'Thank you for your order {reference}! We have received it and will confirm shortly.',
  orderConfirmed:
    'Your order {reference} is confirmed. Total: {total}. We will let you know when it is ready.',
  orderReady: 'Your order {reference} is ready for pickup. Thank you for shopping with us!',
  orderCancelled: 'Your order {reference} has been cancelled. If this was a mistake, please reply here.',
  paymentReceived: 'Payment of {amount} received for order {reference}. Thank you!',
  paymentPartial:
    'We received {amount} as partial payment for order {reference}. Outstanding: {balance}.',
  lowStock:
    'Heads up — {product} is running low ({stock} left). Re-order soon from your supplier.',
  greeting: 'Hello! Welcome to {businessName}. How can we help you today?',
  thanks: 'Thank you for shopping with us! Have a great day.',
  unknown:
    "Sorry, we couldn't understand your message. Reply with 'help' to see what we can do.",
};

export const UpdateBusinessSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    ownerName: z.string().min(1).max(200).optional(),
    notifyOnNewOrder: z.boolean().optional(),
    notifyOnLowStock: z.boolean().optional(),
    notifyOnPayment: z.boolean().optional(),
    replyTemplates: ReplyTemplatesSchema.optional(),
  })
  .strict();

export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
