import { useQuery } from '@tanstack/react-query';

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

export interface DashboardBadges {
  pendingOrders: number;
  reviewMessages: number;
  lowStockProducts: number;
}

export const BADGES_QUERY_KEY = ['dashboard', 'badges'] as const;

/**
 * Lightweight badge counts — powers the sidebar and bottom-nav counters.
 * Fresh every 30s while the dashboard is open; SSE pushes invalidate it when
 * an order arrives or a message gets flagged.
 */
export function useBadges() {
  return useQuery({
    queryKey: BADGES_QUERY_KEY,
    queryFn: () => fetchJson<DashboardBadges>('/dashboard/badges'),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
