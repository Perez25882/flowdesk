import { z } from 'zod';
import type { Prisma, WorkflowOperator, WorkflowState } from '@prisma/client';

export const profiles = ['ONLINE_RETAIL', 'CUSTOM_ORDER', 'APPOINTMENT', 'PROFESSIONAL_SERVICES'] as const;
export const settingsInput = z.object({
  profile: z.enum(profiles),
  enabled: z.boolean(),
  supportMode: z.enum(['OWNER_REVIEW', 'VERIFIED_STATUS']),
  revision: z.number().int().min(0),
}).strict();

const retail = ['commerce', 'support'] as const;
const service = ['appointment', 'support'] as const;
export const presets = {
  ONLINE_RETAIL: retail,
  CUSTOM_ORDER: retail,
  APPOINTMENT: service,
  PROFESSIONAL_SERVICES: service,
} as const;

export const definition = 'whatsapp-business';
export const minute = 60_000;
export const day = 1_440 * minute;
export const terminal = new Set<WorkflowState>(['COMPLETED', 'FAILED', 'CANCELLED']);

export type EventType =
  | 'COMMERCE_QUOTE' | 'COMMERCE_CASE' | 'COMMERCE_RESOLVED' | 'COMMERCE_INVOICE' | 'PICKUP_COMPLETED'
  | 'WHATSAPP_INBOUND' | 'PROCESSING' | 'SALES_QUOTE' | 'ORDER_LINKED'
  | 'PAYMENT_REQUEST' | 'PAYMENT_SETTLED' | 'DELIVERY_DISPATCHED'
  | 'DELIVERY_COMPLETED' | 'APPOINTMENT_BOOKED' | 'SUPPORT_LOOKUP'
  | 'OUTBOUND_AUTHORIZED' | 'OUTBOUND_CONFIRMED' | 'CUSTOMER_INPUT' | 'REVIEW'
  | 'APPROVAL_REQUESTED' | 'APPROVAL_APPROVED' | 'APPROVAL_REJECTED'
  | 'CANCELLED' | 'RETRY_REQUESTED' | 'DEADLINE';

export type BusinessEvent = {
  type: EventType;
  key: string;
  state: WorkflowState;
  operator: WorkflowOperator;
  reason: string;
  facts?: Prisma.InputJsonObject;
  links?: { orderId?: string; appointmentId?: string; sendId?: string };
  deadlineAt?: Date;
};

type State = WorkflowState;
const transitionsV1: Record<Exclude<EventType, 'WHATSAPP_INBOUND' | 'DEADLINE'>, {
  from?: readonly State[]; to: readonly State[];
}> = {
  PROCESSING: { from: ['CREATED'], to: ['RUNNING'] },
  SALES_QUOTE: { from: ['RUNNING'], to: ['READY'] },
  ORDER_LINKED: { from: ['RUNNING', 'WAITING_STAFF', 'WAITING_CUSTOMER'], to: ['WAITING_STAFF'] },
  COMMERCE_QUOTE: { from: ['RUNNING', 'WAITING_STAFF', 'WAITING_CUSTOMER'], to: ['WAITING_STAFF', 'WAITING_CUSTOMER'] },
  COMMERCE_CASE: { from: ['RUNNING', 'WAITING_STAFF', 'WAITING_CUSTOMER'], to: ['WAITING_STAFF', 'WAITING_CUSTOMER'] },
  COMMERCE_RESOLVED: { from: ['RUNNING', 'WAITING_STAFF', 'WAITING_CUSTOMER', 'WAITING_PROVIDER'], to: ['COMPLETED'] },
  COMMERCE_INVOICE: { from: ['RUNNING', 'WAITING_PROVIDER'], to: ['WAITING_PROVIDER'] },
  PICKUP_COMPLETED: { from: ['WAITING_STAFF', 'RETRY_SCHEDULED'], to: ['READY'] },
  PAYMENT_REQUEST: { from: ['WAITING_STAFF', 'WAITING_PROVIDER', 'RETRY_SCHEDULED'], to: ['WAITING_PROVIDER'] },
  PAYMENT_SETTLED: { from: ['WAITING_STAFF', 'WAITING_PROVIDER', 'RETRY_SCHEDULED'], to: ['WAITING_STAFF'] },
  DELIVERY_DISPATCHED: { from: ['WAITING_STAFF', 'RETRY_SCHEDULED'], to: ['WAITING_STAFF'] },
  DELIVERY_COMPLETED: { from: ['WAITING_STAFF', 'RETRY_SCHEDULED'], to: ['READY'] },
  APPOINTMENT_BOOKED: { from: ['RUNNING'], to: ['READY'] },
  SUPPORT_LOOKUP: { from: ['RUNNING'], to: ['READY'] },
  OUTBOUND_AUTHORIZED: { from: ['RUNNING', 'READY', 'RETRY_SCHEDULED'], to: ['WAITING_PROVIDER'] },
  OUTBOUND_CONFIRMED: { from: ['RUNNING', 'READY', 'WAITING_PROVIDER', 'RETRY_SCHEDULED'], to: ['COMPLETED'] },
  CUSTOMER_INPUT: { from: ['RUNNING', 'READY', 'WAITING_CUSTOMER'], to: ['WAITING_CUSTOMER'] },
  REVIEW: { to: ['REVIEW_REQUIRED'] },
  APPROVAL_REQUESTED: { from: ['RUNNING'], to: ['WAITING_OWNER_APPROVAL'] },
  APPROVAL_APPROVED: { from: ['WAITING_OWNER_APPROVAL'], to: ['READY'] },
  APPROVAL_REJECTED: { from: ['WAITING_OWNER_APPROVAL'], to: ['FAILED'] },
  CANCELLED: { to: ['CANCELLED'] },
  RETRY_REQUESTED: { from: ['REVIEW_REQUIRED'], to: ['RETRY_SCHEDULED'] },
};

const definitions = new Map([
  [1, Object.freeze({ approvalWindowMs: day, transitions: transitionsV1 })],
  [2, Object.freeze({ approvalWindowMs: 12 * 60 * minute, transitions: transitionsV1 })],
  [3, Object.freeze({ approvalWindowMs: 12 * 60 * minute, transitions: transitionsV1 })],
]);

export function pinnedDefinition(key: string, version: number): { readonly approvalWindowMs: number } | undefined {
  return key === definition ? definitions.get(version) : undefined;
}

export function allowsTransition(key: string, version: number, from: State, event: BusinessEvent): boolean {
  if (terminal.has(from) || event.type === 'WHATSAPP_INBOUND' || event.type === 'DEADLINE') return false;
  if (version < 3 && (event.type.startsWith('COMMERCE_') || event.type === 'PICKUP_COMPLETED' ||
      (event.type === 'ORDER_LINKED' && from !== 'RUNNING'))) return false;
  const rule = key === definition ? definitions.get(version)?.transitions[event.type] : undefined;
  if (!rule) return event.type === 'REVIEW' && event.state === 'REVIEW_REQUIRED';
  return rule.to.includes(event.state) && (!rule.from || rule.from.includes(from));
}
