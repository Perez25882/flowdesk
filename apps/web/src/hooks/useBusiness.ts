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

export interface Business {
  id: string;
  name: string;
  phone: string;
  ownerName: string;
  plan: 'STARTER' | 'BUSINESS' | 'GROWTH' | 'ENTERPRISE' | 'SUSPENDED';
  trialEndsAt: string | null;
  waWebhookVerified: boolean;
  monthlyConvoCount: number;
  notifyOnNewOrder: boolean;
  notifyOnLowStock: boolean;
  notifyOnPayment: boolean;
  replyTemplates: Record<string, string> | null;
  createdAt: string;
}

export interface UpdateBusinessInput {
  name?: string;
  ownerName?: string;
  notifyOnNewOrder?: boolean;
  notifyOnLowStock?: boolean;
  notifyOnPayment?: boolean;
  replyTemplates?: Record<string, string> | null;
}

export const BUSINESS_QUERY_KEY = ['business', 'me'] as const;

export function useBusiness() {
  return useQuery({
    queryKey: BUSINESS_QUERY_KEY,
    queryFn: () => fetchJson<Business>('/businesses/me'),
    staleTime: 60_000,
  });
}

export function useUpdateBusiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateBusinessInput) =>
      fetchJson<Business>('/businesses/me', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      qc.setQueryData(BUSINESS_QUERY_KEY, data);
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });
}
