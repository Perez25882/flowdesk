import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type Segment = 'new' | 'regular' | 'big_spender' | 'at_risk' | 'lapsed' | 'browser';
export type JourneyStage = 'greeted' | 'asked' | 'wanted' | 'billed' | 'paid';

export interface CustomerInsights {
  totalCustomers: number;
  /** True when the figures cover recent customers only, because the shop is large. */
  truncated: boolean;
  segments: Array<{
    segment: Segment;
    count: number;
    value: number;
    title: string;
    blurb: string;
  }>;
  goingQuiet: Array<{
    id: string;
    name: string | null;
    waNumber: string;
    totalSpend: number;
    totalOrders: number;
    daysSilent: number | null;
    typicalGapDays: number | null;
  }>;
  funnel: Array<{ stage: JourneyStage; reached: number; stoppedHere: number; label: string }>;
  worstStep: { from: JourneyStage; to: JourneyStage; lost: number; rate: number } | null;
}

export function useCustomerInsights(): UseQueryResult<CustomerInsights, Error> {
  return useQuery({
    queryKey: ['customers', 'insights'],
    queryFn: () => apiFetch<CustomerInsights>('/customers/insights'),
    // Nothing here changes minute to minute, and it is several aggregates over
    // the whole customer table. Refetching on every tab focus would be a real
    // cost for a figure that is the same as it was five minutes ago.
    staleTime: 5 * 60_000,
  });
}
