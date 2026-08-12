import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { type PaymentConfidence, type PaymentDirection } from '@flowdesk/shared';
import { apiFetch } from '@/lib/api';



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
    direction: PaymentDirection;
    confidence: PaymentConfidence;
    voidedAt: string | null;
    createdAt: string;
  }>;
}

export function useCustomers(search?: string, tag?: string, hasBalance?: boolean): UseQueryResult<Customer[], Error> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  if (hasBalance) params.set('hasBalance', 'true');
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['customers', search, tag, hasBalance],
    queryFn: () => apiFetch<Customer[]>(`/customers${query}`),
    staleTime: 30_000,
  });
}

export function useCustomerDetail(customerId: string | null): UseQueryResult<CustomerProfile, Error> {
  return useQuery({
    queryKey: ['customers', 'detail', customerId],
    queryFn: () => apiFetch<CustomerProfile>(`/customers/${customerId}`),
    enabled: !!customerId,
    staleTime: 30_000,
  });
}

export function useUpdateCustomer(): UseMutationResult<Customer, Error, { id: string; data: Partial<Customer> }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Customer> }) =>
      apiFetch<Customer>(`/customers/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customers', 'detail', id] });
    },
  });
}
