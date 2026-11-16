import { z } from 'zod';

const id = z.string().min(1).max(100);
export const policyInput = z.object({
  enabled: z.boolean(),
  allowPickup: z.boolean(),
  allowDelivery: z.boolean(),
  quoteMinutes: z.number().int().min(5).max(1440),
  invoiceDays: z.number().int().min(1).max(90),
  depositPercent: z.number().int().min(0).max(90),
  releaseOnDeposit: z.boolean(),
  allowFollowup: z.boolean().default(false),
  revision: z.number().int().min(0),
}).strict().refine((value) => value.allowPickup || value.allowDelivery, 'Choose at least one fulfillment mode')
  .refine((value) => !value.releaseOnDeposit || value.depositPercent > 0, 'Deposit release requires a deposit');

export const quoteInput = z.object({
  customerId: id,
  requestKey: z.string().min(8).max(100),
  sourceId: id.optional(),
  deliveryMode: z.enum(['PICKUP', 'DELIVERY']),
  address: z.string().trim().min(5).max(300).optional(),
  specification: z.string().trim().min(4).max(700).optional(),
  items: z.array(z.object({ productId: id, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(10),
}).strict().refine((value) => new Set(value.items.map((item) => item.productId)).size === value.items.length, 'Select each SKU once')
  .refine((value) => (value.deliveryMode === 'DELIVERY') === Boolean(value.address), 'Enter an address for delivery');

export const quoteDecisionInput = z.object({ decision: z.enum(['OFFER', 'DECLINE']) }).strict();
const moneyMinor = z.number().int().min(1).max(100_000_000);
export const invoiceDraftInput = z.object({
  customerId: id, dueAt: z.string().datetime(), terms: z.string().trim().max(240).optional(),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(1000),
    unitMinor: moneyMinor }).strict()).min(1).max(12),
}).strict();
export const invoiceCheckoutInput = z.object({ send: z.boolean().default(false), amountMinor: moneyMinor.optional(),
  checkoutVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const invoiceDecisionInput = z.object({ action: z.enum(['ISSUE', 'CANCEL', 'SEND']) }).strict();
export const invoiceAdjustmentInput = z.object({ amountMinor: moneyMinor, reference: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(3).max(350), requestKey: z.string().uuid() }).strict();
export const reminderPolicyInput = z.object({ enabled: z.boolean(), intervalDays: z.number().int().min(1).max(30),
  maxReminders: z.number().int().min(1).max(3),
  templateName: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
  templateLanguage: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?$/).nullable(),
}).strict().refine((value) => Boolean(value.templateName) === Boolean(value.templateLanguage), 'Specify a template name and language together');
export const preparationInput = z.object({ state: z.enum(['PREPARING', 'READY']), assignedStaffId: id.nullable() }).strict();
export const caseInput = z.object({
  state: z.enum(['ASSIGNED', 'WAITING', 'ESCALATED', 'RESOLVED']),
  revision: z.number().int().min(0),
  staffId: id.nullable(),
  resolution: z.enum(['EXPLAINED_VERIFIED_STATUS', 'CUSTOMER_CONFIRMED_RESOLUTION', 'CANCELLATION_CONFIRMED', 'REFERRED_TO_OWNER']).optional(),
  evidenceMessageId: id.optional(),
}).strict();

export const partialReturnInput = z.object({ requestKey: z.string().uuid(), revision: z.number().int().min(0),
  evidence: z.string().trim().min(4).max(350), obligation: z.enum(['NONE', 'REFUND_REVIEW', 'REPLACEMENT', 'EXCHANGE']),
  lines: z.array(z.object({ orderItemId: id, quantity: z.number().int().min(1).max(1000),
    condition: z.enum(['RESTOCKABLE', 'DAMAGED', 'REVIEW']) }).strict()).min(1).max(10),
}).strict().refine((value) => new Set(value.lines.map((line) => line.orderItemId)).size === value.lines.length, 'Choose each order item once');

export const returnResolutionInput = z.union([z.object({ paymentId: id }).strict(), z.object({ evidenceMessageId: id }).strict()]);

export type QuoteInput = z.infer<typeof quoteInput>;
export type InvoiceDraftInput = z.infer<typeof invoiceDraftInput>;

export function followupConsent(body: string | null): boolean | undefined {
  const command = body?.trim().toUpperCase();
  return command === 'START ORDER FOLLOWUPS' ? true : command === 'STOP ORDER FOLLOWUPS' ? false : undefined;
}

export function reminderConsent(body: string | null): boolean | undefined {
  const command = body?.trim().toUpperCase();
  return command === 'START PAYMENT REMINDERS' ? true : command === 'STOP PAYMENT REMINDERS' ? false : undefined;
}

export type QuoteCommand =
  | { kind: 'quote'; items: Array<{ sku: string; quantity: number }>; deliveryMode: 'PICKUP' | 'DELIVERY'; address?: string; specification?: string }
  | { kind: 'accept'; id: string }
  | { kind: 'decline'; id: string };

export function quoteCommand(body: string | null): QuoteCommand | null {
  const text = body?.trim();
  if (!text || text.length > 900) return null;
  const decision = /^(ACCEPT|DECLINE) ([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.exec(text);
  if (decision) return { kind: decision[1]!.toUpperCase() === 'ACCEPT' ? 'accept' : 'decline', id: decision[2]!.toLowerCase() };
  const offer = /^QUOTE ([A-Z\d_-]+\*\d+(?:,\s*[A-Z\d_-]+\*\d+){0,9}) (PICKUP|DELIVERY: [^|]+?)(?:\s*\|\s*SPEC: (.+))?$/i.exec(text);
  if (!offer) return null;
  const items = offer[1]!.split(',').map((part) => {
    const [sku, quantity] = part.trim().split('*');
    return { sku: sku!.toUpperCase(), quantity: Number(quantity) };
  });
  if (new Set(items.map((item) => item.sku)).size !== items.length || items.some((item) => item.quantity < 1 || item.quantity > 1000)) return null;
  const pickup = offer[2]!.toUpperCase() === 'PICKUP';
  return { kind: 'quote', items, deliveryMode: pickup ? 'PICKUP' : 'DELIVERY',
    ...(!pickup ? { address: offer[2]!.slice('DELIVERY: '.length).trim() } : {}),
    ...(offer[3] ? { specification: offer[3].trim() } : {}) };
}
