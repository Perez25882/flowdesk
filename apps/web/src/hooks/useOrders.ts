import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch, apiFetchPaged, type PageMeta } from '@/lib/api';
import type { OrderWithRelations, OrderStatus, CreateOrderInput, UpdateOrderStatusInput, AssignOrderInput, OrderStats } from '@/types/order';

const STALE_TIME = 30_000;

/** Rows per page in the orders list. Enough to scan, few enough to load fast on 3G. */
export const ORDER_PAGE_SIZE = 25;

export type OrderListFilter = OrderStatus | 'ALL';

export type OrderCounts = Record<OrderListFilter, number>;

/**
 * One page of orders, with how many there are in total.
 *
 * Unlike `useOrdersByStatus`, this knows there is more than it fetched. The
 * previous page stays on screen while the next loads, so paging does not flash
 * an empty table between clicks.
 */
export function useOrderList(params: {
  status: OrderListFilter;
  search: string;
  page: number;
  staffId?: string | undefined;
}): UseQueryResult<{ data: OrderWithRelations[]; meta: PageMeta }, Error> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(ORDER_PAGE_SIZE),
  });
  if (params.status !== 'ALL') query.set('status', params.status);
  if (params.search.trim()) query.set('search', params.search.trim());
  if (params.staffId) query.set('staffId', params.staffId);

  return useQuery({
    queryKey: ['orders', 'list', params.status, params.search, params.page, params.staffId ?? null],
    queryFn: () => apiFetchPaged<OrderWithRelations[]>(`/orders?${query.toString()}`),
    placeholderData: keepPreviousData,
    staleTime: STALE_TIME,
  });
}

/** How many orders are in each status, under the same search and staff filter as the list. */
export function useOrderCounts(params: {
  search: string;
  staffId?: string | undefined;
}): UseQueryResult<OrderCounts, Error> {
  const query = new URLSearchParams();
  if (params.search.trim()) query.set('search', params.search.trim());
  if (params.staffId) query.set('staffId', params.staffId);

  return useQuery({
    queryKey: ['orders', 'counts', params.search, params.staffId ?? null],
    queryFn: () => apiFetch<OrderCounts>(`/orders/counts?${query.toString()}`),
    placeholderData: keepPreviousData,
    staleTime: STALE_TIME,
  });
}

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
