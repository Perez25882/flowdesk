import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type { AiAssistMode, BusinessProfile, BusinessType, CatalogueMode } from '@flowdesk/shared';
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
  businessType: BusinessType | null;
  businessTypeOther: string | null;
  businessProfile: BusinessProfile | null;
  businessPolicyNotes: string | null;
  profileUpdatedAt: string | null;
  aiAssistMode: AiAssistMode;
  catalogueMode: CatalogueMode;
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
  businessType?: BusinessType | null;
  businessTypeOther?: string | null;
  /**
   * Merged server-side over what is stored, so a partial save is safe — sending
   * only the section that changed will not erase the others.
   */
  businessProfile?: BusinessProfile | null;
  businessPolicyNotes?: string | null;
  aiAssistMode?: AiAssistMode;
  catalogueMode?: CatalogueMode;
}

/**
 * One entry of the auto-reply catalogue, served by `GET /settings/templates`.
 *
 * The dashboard renders from this rather than its own list. It used to keep a
 * hand-copied duplicate of the labels AND the default wording, which had to stay
 * byte-identical to the reply engine's — with nothing to catch it when it
 * didn't. `defaultText` is what the customer receives when the owner has not
 * customised the reply; `text` is their override, null when unset.
 */
export interface ReplyTemplateEntry {
  key: string;
  label: string;
  description: string;
  variables: string[];
  text: string | null;
  defaultText: string;
  enabled: boolean;
}

export const BUSINESS_QUERY_KEY = ['business', 'me'] as const;
export const REPLY_TEMPLATES_QUERY_KEY = ['settings', 'templates'] as const;

export function useReplyTemplates(): UseQueryResult<ReplyTemplateEntry[], Error> {
  return useQuery({
    queryKey: REPLY_TEMPLATES_QUERY_KEY,
    queryFn: () => apiFetch<ReplyTemplateEntry[]>('/settings/templates'),
    staleTime: 60_000,
  });
}

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
