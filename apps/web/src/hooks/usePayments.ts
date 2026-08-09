import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



export interface Payment {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  verified: boolean;
  verifiedAt: string | null;
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
  reference?: string;
  notes?: string;
}

export function usePayments(verified?: boolean, hasScreenshot?: boolean): UseQueryResult<Payment[], Error> {
  const params = new URLSearchParams();
  if (verified !== undefined) params.set('verified', String(verified));
  if (hasScreenshot) params.set('hasScreenshot', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['payments', verified, hasScreenshot],
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

export function useVerifyPayment(): UseMutationResult<Payment, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Payment>(`/payments/${id}/verify`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useDeletePayment(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/payments/${id}`, { method: 'DELETE' }),
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
