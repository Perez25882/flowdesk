import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

export function usePayments(verified?: boolean, hasScreenshot?: boolean) {
  const params = new URLSearchParams();
  if (verified !== undefined) params.set('verified', String(verified));
  if (hasScreenshot) params.set('hasScreenshot', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['payments', verified, hasScreenshot],
    queryFn: () => fetchJson<Payment[]>(`/payments${query}`),
    staleTime: 30_000,
  });
}

export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentInput) =>
      fetchJson<Payment>('/payments', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useVerifyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<Payment>(`/payments/${id}/verify`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useDeletePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<void>(`/payments/${id}`, { method: 'DELETE' }),
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

export function useRevenueStats() {
  return useQuery({
    queryKey: ['payments', 'stats'],
    queryFn: () => fetchJson<RevenueStats>('/payments/stats'),
    staleTime: 60_000,
  });
}
