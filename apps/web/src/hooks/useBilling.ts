import { useMutation } from '@tanstack/react-query';

const API_BASE = '/api/v1';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('accessToken');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.data as T;
}

export type BillablePlan = 'STARTER' | 'BUSINESS' | 'GROWTH';

export interface CheckoutResponse {
  authorizationUrl: string;
  reference: string;
}

/**
 * POST /billing/checkout — initialises a Paystack transaction for the requested plan.
 * The returned authorizationUrl is where the browser should navigate to complete payment.
 */
export function useCheckout() {
  return useMutation({
    mutationFn: (plan: BillablePlan) =>
      fetchJson<CheckoutResponse>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      }),
  });
}
