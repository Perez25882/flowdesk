import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



export interface Business {
  id: string;
  name: string;
  phone: string;
  ownerName: string;
  plan: 'STARTER' | 'BUSINESS' | 'GROWTH' | 'ENTERPRISE' | 'SUSPENDED';
  trialEndsAt: string | null;
  waWebhookVerified: boolean;
  monthlyConvoCount: number;
  notifyOnNewOrder: boolean;
  notifyOnLowStock: boolean;
  notifyOnPayment: boolean;
  replyTemplates: ReplyTemplatesConfig | null;
  createdAt: string;
}

/**
 * Mirrors `ReplyTemplatesSchema` on the API: customised wording lives under
 * `overrides` keyed by the reply engine's template keys, and `disabled` switches
 * a reply off entirely. Sending a flat map instead is rejected with a 400.
 */
export interface ReplyTemplatesConfig {
  overrides?: Record<string, string> | null;
  disabled?: string[] | null;
}

export interface UpdateBusinessInput {
  name?: string;
  ownerName?: string;
  notifyOnNewOrder?: boolean;
  notifyOnLowStock?: boolean;
  notifyOnPayment?: boolean;
  replyTemplates?: ReplyTemplatesConfig | null;
}

export const BUSINESS_QUERY_KEY = ['business', 'me'] as const;

export function useBusiness(): UseQueryResult<Business, Error> {
  return useQuery({
    queryKey: BUSINESS_QUERY_KEY,
    queryFn: () => apiFetch<Business>('/businesses/me'),
    staleTime: 60_000,
  });
}

export function useUpdateBusiness(): UseMutationResult<Business, Error, UpdateBusinessInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateBusinessInput) =>
      apiFetch<Business>('/businesses/me', {
        method: 'PATCH',
        body: data,
      }),
    onSuccess: (data) => {
      qc.setQueryData(BUSINESS_QUERY_KEY, data);
      qc.invalidateQueries({ queryKey: ['business'] });
    },
  });
}
