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
export const invoiceCheckoutInput = z.object({ send: z.boolean().default(false) }).strict();
export const preparationInput = z.object({ state: z.enum(['PREPARING', 'READY']), assignedStaffId: id.nullable() }).strict();
export const caseInput = z.object({
  state: z.enum(['ASSIGNED', 'WAITING', 'ESCALATED', 'RESOLVED']),
  revision: z.number().int().min(0),
  staffId: id.nullable(),
  resolution: z.enum(['EXPLAINED_VERIFIED_STATUS', 'CUSTOMER_CONFIRMED_RESOLUTION', 'CANCELLATION_CONFIRMED', 'REFERRED_TO_OWNER']).optional(),
  evidenceMessageId: id.optional(),
}).strict();

export type QuoteInput = z.infer<typeof quoteInput>;

export function followupConsent(body: string | null): boolean | undefined {
  const command = body?.trim().toUpperCase();
  return command === 'START ORDER FOLLOWUPS' ? true : command === 'STOP ORDER FOLLOWUPS' ? false : undefined;
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
