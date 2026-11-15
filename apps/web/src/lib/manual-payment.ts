import type { CreatePaymentInput } from '@/hooks/usePayments';
import { ApiError } from './api';

export interface PendingManualPayment {
  key: string;
  data: CreatePaymentInput;
}

export function manualPaymentSlot(businessId: string, staffId: string | undefined, orderId: string): string {
  return 'flowdesk.payment.' + JSON.stringify([businessId, staffId ?? null, orderId]);
}

export function loadManualPayment(storage: Storage, slot: string): PendingManualPayment | null {
  const value = storage.getItem(slot);
  if (!value) return null;
  const pending = JSON.parse(value) as PendingManualPayment;
  if (typeof pending?.key !== 'string' || !pending.data || typeof pending.data.amount !== 'number' ||
      typeof pending.data.customerId !== 'string' || typeof pending.data.method !== 'string') {
    throw new Error('The saved payment request is unreadable');
  }
  return pending;
}

export function prepareManualPayment(storage: Storage, slot: string, data: CreatePaymentInput): PendingManualPayment {
  const prior = loadManualPayment(storage, slot);
  if (prior) return prior;
  const pending = { key: crypto.randomUUID(), data };
  storage.setItem(slot, JSON.stringify(pending));
  return pending;
}

export function clearManualPayment(storage: Storage, slot: string, key: string): void {
  if (loadManualPayment(storage, slot)?.key === key) storage.removeItem(slot);
}

export function isRejectedFirstPaymentSubmission(error: unknown, hadUnconfirmedSubmission: boolean): boolean {
  return !hadUnconfirmedSubmission && error instanceof ApiError && [400, 422].includes(error.status);
}
