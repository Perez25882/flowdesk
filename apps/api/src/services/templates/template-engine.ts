import type { OrderStatus } from '../../types/prisma-enums.js';

export type TemplateKey =
  | 'order_pending'
  | 'order_confirmed'
  | 'order_processing'
  | 'order_fulfilled'
  | 'order_cancelled'
  | 'payment_received'
  | 'status_check_response'
  | 'greeting';

interface TemplateVariables {
  name?: string;
  ref?: string;
  business?: string;
  amount?: string;
  status?: string;
  details?: string;
  reason?: string;
}

const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
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
};

function resolveTemplate(
  templates: Record<string, unknown> | null | undefined,
  key: TemplateKey,
): string {
  if (templates && typeof templates === 'object' && key in templates) {
    const value = templates[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return DEFAULT_TEMPLATES[key];
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
  customTemplates: Record<string, unknown> | null | undefined,
  key: TemplateKey,
  variables: TemplateVariables,
): string {
  const template = resolveTemplate(customTemplates, key);
  return interpolate(template, variables);
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

export function shouldSendAutoReply(
  lastInteractionAt: Date | null | undefined,
): { withinWindow: boolean } {
  if (!lastInteractionAt) {
    return { withinWindow: false };
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return { withinWindow: lastInteractionAt > twentyFourHoursAgo };
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

export function isTemplateEnabled(
  disabledTemplates: string[] | undefined,
  key: TemplateKey,
): boolean {
  if (!disabledTemplates || disabledTemplates.length === 0) {
    return true;
  }
  return !disabledTemplates.includes(key);
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
};
