import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface InsightFacts {
  date: string;
  messagesIn: number;
  messagesOut: number;
  customersWhoWrote: number;
  newCustomers: number;
  ordersCreated: number;
  ordersValue: number;
  ordersFulfilled: number;
  ordersCancelled: number;
  revenue: number;
  paymentLinksOpen: number;
  paymentLinksOpenValue: number;
  awaitingOwner: number;
  unverifiedRepliesSent: number;
  lowStockCount: number;
  lowStockNames: string[];
  topProducts: Array<{ name: string; quantity: number; value: number }>;
  previous: { messagesIn: number; ordersCreated: number; revenue: number };
}

export interface DailyInsight {
  id: string;
  forDate: string;
  headline: string;
  body: string;
  facts: InsightFacts;
  /** Null when the plain version was used rather than a generated one. */
  model: string | null;
  sentAt: string | null;
}

export function useLatestInsight(): UseQueryResult<DailyInsight | null, Error> {
  return useQuery({
    queryKey: ['insights', 'latest'],
    queryFn: () => apiFetch<DailyInsight | null>('/insights/latest'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useInsights(limit = 14): UseQueryResult<DailyInsight[], Error> {
  return useQuery({
    queryKey: ['insights', limit],
    queryFn: () => apiFetch<DailyInsight[]>(`/insights?limit=${limit}`),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Writes today's summary now instead of waiting for the morning.
 *
 * Queued server-side, so success here means "asked for", not "written". The
 * card refetches shortly after rather than pretending the result is immediate.
 */
export function useRunInsight(): UseMutationResult<{ queued: boolean }, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ queued: boolean }>('/insights/run', { method: 'POST', body: {} }),
    onSuccess: () => {
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['insights'] });
      }, 4000);
    },
  });
}
