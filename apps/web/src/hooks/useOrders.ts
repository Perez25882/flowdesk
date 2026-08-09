import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { OrderWithRelations, OrderStatus, CreateOrderInput, UpdateOrderStatusInput, AssignOrderInput, OrderStats } from '@/types/order';



const STALE_TIME = 30_000;

export function useOrdersByStatus(status: OrderStatus, staffId?: string): UseQueryResult<OrderWithRelations[], Error> {
  const params = new URLSearchParams({ status });
  if (staffId) params.set('staffId', staffId);
  return useQuery({
    queryKey: ['orders', 'byStatus', status, staffId ?? null],
    queryFn: () => apiFetch<OrderWithRelations[]>(`/orders?${params.toString()}`),
    staleTime: STALE_TIME,
  });
}

export function useOrderDetail(orderId: string | null): UseQueryResult<OrderWithRelations, Error> {
  return useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => apiFetch<OrderWithRelations>(`/orders/${orderId}`),
    enabled: !!orderId,
    staleTime: STALE_TIME,
  });
}

export function useCreateOrder(): UseMutationResult<OrderWithRelations, Error, CreateOrderInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOrderInput) =>
      apiFetch<OrderWithRelations>('/orders', {
        method: 'POST',
        body: data,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', 'stats'] });
    },
  });
}

export function useUpdateOrderStatus(): UseMutationResult<OrderWithRelations, Error, { orderId: string; data: UpdateOrderStatusInput }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, data }: { orderId: string; data: UpdateOrderStatusInput }) =>
      apiFetch<OrderWithRelations>(`/orders/${orderId}/status`, {
        method: 'PATCH',
        body: data,
      }),
    onMutate: async ({ orderId, data }) => {
      await qc.cancelQueries({ queryKey: ['orders'] });

      const previousOrders = qc.getQueriesData<OrderWithRelations[]>({
        queryKey: ['orders', 'byStatus'],
      });

      // The board keeps one cache per column, so moving a card means removing
      // it from the source list and adding it to the target list. Patching the
      // status in place left the card in its old column until the refetch
      // landed, which read as the card snapping back and then jumping.
      //
      // Iterated per key rather than through `setQueriesData` because the
      // updater there is not given the query key, and the key is what says
      // which column a cache belongs to.
      const moved = previousOrders
        .flatMap(([, orders]) => orders ?? [])
        .find((order) => order.id === orderId);

      for (const [key] of previousOrders) {
        // ['orders', 'byStatus', status, staffId]
        const columnStatus = key[2] as OrderStatus | undefined;

        qc.setQueryData<OrderWithRelations[]>(key, (old) => {
          if (!old) return old;

          const without = old.filter((order) => order.id !== orderId);

          if (columnStatus === data.status && moved) {
            return [{ ...moved, status: data.status }, ...without];
          }

          return without;
        });
      }

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

export function useAssignOrder(): UseMutationResult<OrderWithRelations, Error, { orderId: string; data: AssignOrderInput }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, data }: { orderId: string; data: AssignOrderInput }) =>
      apiFetch<OrderWithRelations>(`/orders/${orderId}/assign`, {
        method: 'PATCH',
        body: data,
      }),
    onSuccess: (_data, { orderId }) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
    },
  });
}

export function useOrderStats(period: 'today' | 'week' | 'month' = 'today', staffId?: string): UseQueryResult<OrderStats, Error> {
  const params = new URLSearchParams({ period });
  if (staffId) params.set('staffId', staffId);
  return useQuery({
    queryKey: ['orders', 'stats', period, staffId ?? null],
    queryFn: () => apiFetch<OrderStats>(`/orders/stats?${params.toString()}`),
    staleTime: STALE_TIME,
  });
}
