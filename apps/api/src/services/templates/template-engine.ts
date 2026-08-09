import type { OrderStatus } from '../../types/prisma-enums.js';

export type TemplateKey =
  | 'order_pending'
  | 'order_confirmed'
  | 'order_processing'
  | 'order_fulfilled'
  | 'order_cancelled'
  | 'payment_received'
  | 'status_check_response'
  | 'greeting'
  | 'inquiry'
  | 'payment'
  | 'complaint'
  | 'fallback';

interface TemplateVariables {
  name?: string;
  ref?: string;
  business?: string;
  amount?: string;
  status?: string;
  details?: string;
  reason?: string;
}

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  order_pending:
    'Hi {name}! We received your order (Ref: {ref}). We\'ll confirm shortly. — {business}',
  order_confirmed:
    'Your order {ref} is confirmed and being prepared. We\'ll let you know when it\'s ready. — {business}',
  order_processing:
    'Your order {ref} is being packed and prepared for delivery/pickup. — {business}',
  order_fulfilled:
    'Your order {ref} has been completed. Thank you for your business! — {business}',
  order_cancelled:
    'Your order {ref} has been cancelled. {reason} Please contact us if you have questions. — {business}',
  payment_received:
    'Payment of GHS {amount} received for order {ref}. Thank you! — {business}',
  status_check_response:
    'Your order {ref} is currently: {status}. {details} — {business}',
  greeting:
    'Hello {name}! Welcome to {business}. How can we help you today?',
  inquiry:
    'Hi {name}! Thanks for your question. Please share more details and we’ll get back to you right away. — {business}',
  payment:
    'Hi {name}! We received your payment message. Please share the order reference or amount and we’ll confirm. — {business}',
  complaint:
    'Hi {name}! We’re sorry for the inconvenience. Please share more details and we’ll look into it immediately. — {business}',
  fallback:
    'Hi {name}! We received your message. Our team will review it and get back to you shortly. — {business}',
};

/**
 * Per-business auto-reply configuration, persisted on `Business.replyTemplates`.
 *
 * `overrides` replaces the default wording for a key; `disabled` switches that
 * auto-reply off entirely. Both are keyed by {@link TemplateKey} — the single
 * canonical key set for the whole system.
 */
export interface ReplyTemplateConfig {
  overrides: Partial<Record<TemplateKey, string>>;
  disabled: TemplateKey[];
}

const EMPTY_CONFIG: ReplyTemplateConfig = { overrides: {}, disabled: [] };

function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as string[]).includes(value);
}

/**
 * Normalises whatever is stored in the `replyTemplates` JSON column.
 *
 * Accepts both the structured shape and the older flat `{ key: text }` form so
 * existing rows keep working. Unknown keys are ignored rather than rejected —
 * a stale key must not break the reply pipeline for every other template.
 */
export function parseTemplateConfig(value: unknown): ReplyTemplateConfig {
  if (value === null || value === undefined || typeof value !== 'object') {
    return EMPTY_CONFIG;
  }

  const record = value as Record<string, unknown>;
  const overrides: Partial<Record<TemplateKey, string>> = {};
  const disabled: TemplateKey[] = [];

  const rawOverrides =
    'overrides' in record && typeof record.overrides === 'object' && record.overrides !== null
      ? (record.overrides as Record<string, unknown>)
      : record;

  for (const [key, text] of Object.entries(rawOverrides)) {
    if (isTemplateKey(key) && typeof text === 'string' && text.trim().length > 0) {
      overrides[key] = text;
    }
  }

  if (Array.isArray(record.disabled)) {
    for (const key of record.disabled) {
      if (isTemplateKey(key)) {
        disabled.push(key);
      }
    }
  }

  return { overrides, disabled };
}

function resolveTemplate(config: ReplyTemplateConfig, key: TemplateKey): string {
  return config.overrides[key] ?? DEFAULT_TEMPLATES[key];
}

function interpolate(template: string, variables: TemplateVariables): string {
  let result = template;

  const replacements: Record<string, string | undefined> = {
    name: variables.name ?? 'there',
    ref: variables.ref ?? '',
    business: variables.business ?? '',
    amount: variables.amount ?? '',
    status: variables.status ?? '',
    details: variables.details ?? '',
    reason: variables.reason ?? '',
  };

  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{${key}}`, value ?? '');
  }

  return result;
}

export function renderTemplate(
  config: ReplyTemplateConfig,
  key: TemplateKey,
  variables: TemplateVariables,
): string {
  return interpolate(resolveTemplate(config, key), variables);
}

export function humanizeStatus(status: OrderStatus | string): string {
  switch (status) {
    case 'PENDING':
      return 'Pending — awaiting confirmation';
    case 'CONFIRMED':
      return 'Confirmed — being prepared';
    case 'PROCESSING':
      return 'Processing — being packed';
    case 'FULFILLED':
      return 'Fulfilled — delivered/collected';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return String(status);
  }
}

export function formatAmount(amount: number): string {
  return `GHS ${amount.toFixed(2)}`;
}

export function getCustomerFirstName(name: string | null | undefined): string {
  if (!name) return '';
  return name.split(' ')[0] ?? name;
}

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether Meta's 24-hour customer-service window is open.
 *
 * Free-form messages may only be sent inside a window that a message FROM the
 * customer opens, so this takes `lastInboundAt` — never `lastInteractionAt`,
 * which the owner's own replies from the WhatsApp Business app also bump
 * (`echo.service.ts`). Gating on the latter let us believe the window was open
 * after Meta had closed it: the send was accepted here, rejected by Meta as
 * non-retryable, and dead-lettered without anything surfacing to the owner.
 *
 * A missing value means no customer message has ever arrived, so the window has
 * never opened. That is CLOSED. This previously returned open, which is the
 * wrong way round to fail on a rule Meta enforces for us.
 */
export function shouldSendAutoReply(
  lastInboundAt: Date | null | undefined,
): { withinWindow: boolean } {
  if (!lastInboundAt) {
    return { withinWindow: false };
  }

  const windowOpenedAfter = new Date(Date.now() - SERVICE_WINDOW_MS);
  return { withinWindow: lastInboundAt > windowOpenedAfter };
}

export function getTemplateKeyForOrderStatus(status: OrderStatus): TemplateKey | null {
  switch (status) {
    case 'PENDING':
      return 'order_pending';
    case 'CONFIRMED':
      return 'order_confirmed';
    case 'PROCESSING':
      return 'order_processing';
    case 'FULFILLED':
      return 'order_fulfilled';
    case 'CANCELLED':
      return 'order_cancelled';
    default:
      return null;
  }
}

export function isTemplateEnabled(config: ReplyTemplateConfig, key: TemplateKey): boolean {
  return !config.disabled.includes(key);
}

export const TEMPLATE_KEYS: TemplateKey[] = [
  'order_pending',
  'order_confirmed',
  'order_processing',
  'order_fulfilled',
  'order_cancelled',
  'payment_received',
  'status_check_response',
  'greeting',
  'inquiry',
  'payment',
  'complaint',
  'fallback',
];

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  order_pending: 'Order Detected',
  order_confirmed: 'Order Confirmed',
  order_processing: 'Order Processing',
  order_fulfilled: 'Order Fulfilled',
  order_cancelled: 'Order Cancelled',
  payment_received: 'Payment Received',
  status_check_response: 'Status Check Response',
  greeting: 'Greeting',
  inquiry: 'Inquiry',
  payment: 'Payment',
  complaint: 'Complaint',
  fallback: 'Fallback',
};

export const TEMPLATE_DESCRIPTIONS: Record<TemplateKey, string> = {
  order_pending: 'Sent when a new order is detected from a customer message',
  order_confirmed: 'Sent when an order is confirmed by staff',
  order_processing: 'Sent when an order moves to processing',
  order_fulfilled: 'Sent when an order is fulfilled',
  order_cancelled: 'Sent when an order is cancelled',
  payment_received: 'Sent when a payment is verified',
  status_check_response: 'Sent when a customer asks about an existing order',
  greeting: 'Sent when a customer sends a greeting message',
  inquiry: 'Sent when a customer asks a general question',
  payment: 'Sent when a customer sends a payment-related message',
  complaint: 'Sent when a customer sends a complaint',
  fallback: 'Sent when a message does not match any other intent',
};

export const TEMPLATE_VARIABLES: Record<TemplateKey, string[]> = {
  order_pending: ['name', 'ref', 'business'],
  order_confirmed: ['name', 'ref', 'business'],
  order_processing: ['name', 'ref', 'business'],
  order_fulfilled: ['name', 'ref', 'business'],
  order_cancelled: ['name', 'ref', 'business', 'reason'],
  payment_received: ['name', 'ref', 'business', 'amount'],
  status_check_response: ['name', 'ref', 'business', 'status', 'details'],
  greeting: ['name', 'business'],
  inquiry: ['name', 'business'],
  payment: ['name', 'business'],
  complaint: ['name', 'business'],
  fallback: ['name', 'business'],
};
