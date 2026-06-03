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

export interface Customer {
  id: string;
  waNumber: string;
  name: string | null;
  outstandingBalance: number;
  totalSpend: number;
  totalOrders: number;
  tags: string[];
  blacklisted: boolean;
  vip: boolean;
  lastInteractionAt: string | null;
  notes: string | null;
}

export interface CustomerProfile extends Customer {
  orders: Array<{
    id: string;
    referenceNumber: string;
    status: string;
    totalAmount: number;
    createdAt: string;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    method: string;
    verified: boolean;
    createdAt: string;
  }>;
}

export function useCustomers(search?: string, tag?: string, hasBalance?: boolean) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  if (hasBalance) params.set('hasBalance', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['customers', search, tag, hasBalance],
    queryFn: () => fetchJson<Customer[]>(`/customers${query}`),
    staleTime: 30_000,
  });
}

export function useCustomerDetail(customerId: string | null) {
  return useQuery({
    queryKey: ['customers', 'detail', customerId],
    queryFn: () => fetchJson<CustomerProfile>(`/customers/${customerId}`),
    enabled: !!customerId,
    staleTime: 30_000,
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Customer> }) =>
      fetchJson<Customer>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customers', 'detail', id] });
    },
  });
}
