import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { apiFetch, apiFetchBlob } from '@/lib/api';

export type ReportWindow = 30 | 60 | 90;

export interface DayPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface ReportSummary {
  days: ReportWindow;
  from: string;
  to: string;
  revenue: number;
  orders: number;
  ordersCompleted: number;
  ordersPending: number;
  ordersCancelled: number;
  averageOrderValue: number;
  outstanding: number;
  series: DayPoint[];
  topProducts: Array<{ name: string; quantity: number; value: number }>;
  previous: { revenue: number; orders: number };
}

export function useReport(days: ReportWindow): UseQueryResult<ReportSummary, Error> {
  return useQuery({
    queryKey: ['reports', days],
    queryFn: () => apiFetch<ReportSummary>(`/reports?days=${days}`),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Downloads the CSV.
 *
 * Fetched through the API client rather than being a plain link, because the
 * access token lives in memory, a bare `<a download>` would arrive
 * unauthenticated and come back 401.
 */
export async function downloadReportCsv(days: ReportWindow, filename: string): Promise<void> {
  const blob = await apiFetchBlob(`/reports/export.csv?days=${days}`);
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoked on the next tick: revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
