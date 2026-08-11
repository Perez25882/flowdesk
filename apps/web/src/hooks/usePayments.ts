import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import { apiFetch } from '@/lib/api';



export interface Payment {
  id: string;
  amount: number;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  attestedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  screenshotUrl: string | null;
  customer: { id: string; name: string | null; waNumber: string };
  orderId: string | null;
  createdAt: string;
}

export interface CreatePaymentInput {
  customerId: string;
  orderId?: string;
  amount: number;
  method: string;
  /** Omit for a normal receipt. 'OUT' records a refund. */
  direction?: PaymentDirection;
  reference?: string;
  notes?: string;
}

export function usePayments(attested?: boolean, hasScreenshot?: boolean): UseQueryResult<Payment[], Error> {
  const params = new URLSearchParams();
  if (attested !== undefined) params.set('attested', String(attested));
  if (hasScreenshot) params.set('hasScreenshot', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['payments', attested, hasScreenshot],
    queryFn: () => apiFetch<Payment[]>(`/payments${query}`),
    staleTime: 30_000,
  });
}

export function useCreatePayment(): UseMutationResult<Payment, Error, CreatePaymentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentInput) =>
      apiFetch<Payment>('/payments', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useAttestPayment(): UseMutationResult<Payment, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Payment>(`/payments/${id}/attest`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

/**
 * Reverses a payment without deleting it. The reason is required by the API —
 * an unexplained reversal is not evidence of anything.
 */
export function useVoidPayment(): UseMutationResult<void, Error, { id: string; reason: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<void>(`/payments/${id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export interface RevenueStats {
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}

export function useRevenueStats(): UseQueryResult<RevenueStats, Error> {
  return useQuery({
    queryKey: ['payments', 'stats'],
    queryFn: () => apiFetch<RevenueStats>('/payments/stats'),
    staleTime: 60_000,
  });
}
