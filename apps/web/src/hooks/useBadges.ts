import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



export interface DashboardBadges {
  pendingOrders: number;
  reviewMessages: number;
  lowStockProducts: number;
}

export const BADGES_QUERY_KEY = ['dashboard', 'badges'] as const;

/**
 * Lightweight badge counts, powers the sidebar and bottom-nav counters.
 * Fresh every 30s while the dashboard is open; SSE pushes invalidate it when
 * an order arrives or a message gets flagged.
 */
export function useBadges(): UseQueryResult<DashboardBadges, Error> {
  return useQuery({
    queryKey: BADGES_QUERY_KEY,
    queryFn: () => apiFetch<DashboardBadges>('/dashboard/badges'),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
