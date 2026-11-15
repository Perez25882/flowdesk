import { describe, expect, it, vi } from 'vitest';
import { clearManualPayment, isRejectedFirstPaymentSubmission, loadManualPayment, manualPaymentSlot, prepareManualPayment } from './manual-payment';
import { ApiError, apiFetch } from './api';

function browserStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
}

const data = { amount: 15, method: 'CASH', customerId: 'customer', orderId: 'order' };
const slot = manualPaymentSlot('shop', 'staff', 'order');

describe('dashboard manual payment requests', () => {
  it('shares one identity for rapid submissions, refresh and an ambiguous HTTP response', async () => {
    const storage = browserStorage();
    const order = prepareManualPayment(storage, slot, data);
    expect(prepareManualPayment(storage, slot, { ...data, amount: 20 })).toEqual(order);
    const request = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(Response.json({ success: true, data: { id: 'one-payment' } }));
    try {
      await expect(apiFetch('/payments', { method: 'POST', body: order.data, idempotencyKey: order.key })).rejects.toThrow();
      const reloaded = loadManualPayment(storage, slot)!;
      expect(reloaded).toEqual(order);
      await expect(apiFetch('/payments', { method: 'POST', body: reloaded.data, idempotencyKey: reloaded.key })).resolves.toEqual({ id: 'one-payment' });
      expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1]);
      expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': order.key });
      clearManualPayment(storage, slot, order.key);
      expect(prepareManualPayment(storage, slot, data).key).not.toBe(order.key);
    } finally {
      request.mockRestore();
    }
  });

  it('separates order, staff, and business and fences removal by request identity', () => {
    const storage = browserStorage();
    const order = prepareManualPayment(storage, slot, data);
    for (const other of [manualPaymentSlot('other', 'staff', 'order'), manualPaymentSlot('shop', undefined, 'order'),
      manualPaymentSlot('shop', 'staff', 'another')]) expect(loadManualPayment(storage, other)).toBeNull();
    clearManualPayment(storage, slot, 'different-key');
    expect(loadManualPayment(storage, slot)).toEqual(order);
  });

  it('does not discard an ambiguous request on a later rejected replay', () => {
    const invalid = new ApiError('Synthetic invalid request', 400, 'VALIDATION_ERROR');
    expect(isRejectedFirstPaymentSubmission(invalid, false)).toBe(true);
    expect(isRejectedFirstPaymentSubmission(invalid, true)).toBe(false);
    expect(isRejectedFirstPaymentSubmission(new Error('Response lost'), false)).toBe(false);
  });
});
