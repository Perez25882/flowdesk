import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface LogoView {
  /** API path the bytes are fetched from, or null when no logo is set. */
  path: string | null;
  mimeType: string | null;
}

export function useLogo(): UseQueryResult<LogoView, Error> {
  return useQuery({
    queryKey: ['settings', 'logo'],
    queryFn: () => apiFetch<LogoView>('/settings/logo'),
    staleTime: 60_000,
  });
}

export function useUploadLogo(): UseMutationResult<LogoView, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: string) =>
      apiFetch<LogoView>('/settings/logo', { method: 'PUT', body: { data } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'logo'] }),
  });
}
