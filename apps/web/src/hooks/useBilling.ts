import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



export type BillablePlan = 'STARTER' | 'BUSINESS' | 'GROWTH';

export interface CheckoutResponse {
  authorizationUrl: string;
  reference: string;
}

/**
 * POST /billing/checkout — initialises a Paystack transaction for the requested plan.
 * The returned authorizationUrl is where the browser should navigate to complete payment.
 */
export function useCheckout(): UseMutationResult<CheckoutResponse, Error, BillablePlan> {
  return useMutation({
    mutationFn: (plan: BillablePlan) =>
      apiFetch<CheckoutResponse>('/billing/checkout', {
        method: 'POST',
        body: { plan },
      }),
  });
}
