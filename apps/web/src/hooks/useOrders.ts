import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { OrderWithRelations, OrderStatus, CreateOrderInput, UpdateOrderStatusInput, AssignOrderInput, OrderStats } from '@/types/order';

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

const STALE_TIME = 30_000;

export function useOrdersByStatus(status: OrderStatus) {
  return useQuery({
    queryKey: ['orders', 'byStatus', status],
    queryFn: () => fetchJson<OrderWithRelations[]>(`/orders?status=${status}`),
    staleTime: STALE_TIME,
  });
}

export function useOrderDetail(orderId: string | null) {
  return useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => fetchJson<OrderWithRelations>(`/orders/${orderId}`),
    enabled: !!orderId,
    staleTime: STALE_TIME,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOrderInput) =>
      fetchJson<OrderWithRelations>('/orders', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', 'stats'] });
    },
  });
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, data }: { orderId: string; data: UpdateOrderStatusInput }) =>
      fetchJson<OrderWithRelations>(`/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onMutate: async ({ orderId, data }) => {
      await qc.cancelQueries({ queryKey: ['orders'] });
      const previousOrders = qc.getQueriesData<OrderWithRelations[]>({ queryKey: ['orders', 'byStatus'] });
      qc.setQueriesData<OrderWithRelations[]>({ queryKey: ['orders', 'byStatus'] }, (old) => {
        if (!old) return old;
        return old.map((o) => (o.id === orderId ? { ...o, status: data.status } : o));
      });
      return { previousOrders };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousOrders) {
        context.previousOrders.forEach(([key, data]) => {
          qc.setQueryData(key, data);
        });
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', 'stats'] });
    },
  });
}

export function useAssignOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, data }: { orderId: string; data: AssignOrderInput }) =>
      fetchJson<OrderWithRelations>(`/orders/${orderId}/assign`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

export function useOrderStats(period: 'today' | 'week' | 'month' = 'today') {
  return useQuery({
    queryKey: ['orders', 'stats', period],
    queryFn: () => fetchJson<OrderStats>(`/orders/stats?period=${period}`),
    staleTime: STALE_TIME,
  });
}
