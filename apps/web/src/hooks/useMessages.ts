import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';



export interface Message {
  id: string;
  waMessageId: string;
  direction: string;
  type: string;
  body: string | null;
  intent: string;
  intentConfidence: number | null;
  classifiedBy: string | null;
  requiresReview: boolean;
  processed: boolean;
  relatedOrderId: string | null;
  createdAt: string;
  customer: { id: string; name: string | null; waNumber: string } | null;
}

export function useMessages(requiresReview?: boolean): UseQueryResult<Message[], Error> {
  const query = requiresReview ? '?requiresReview=true' : '';
  return useQuery({
    queryKey: ['messages', requiresReview],
    queryFn: () => apiFetch<Message[]>(`/messages${query}`),
    staleTime: 30_000,
  });
}

/**
 * Manually reclassify a message's intent. Use this from the review queue —
 * it records who made the correction (for the IntentCorrection log) and flips
 * requiresReview→false once a confident intent is picked.
 */
export function useCorrectMessageIntent(): UseMutationResult<Message, Error, { id: string; intent: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, intent }: { id: string; intent: string }) =>
      apiFetch<Message>(`/messages/${id}/intent`, {
        method: 'PATCH',
        body: { intent },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
    },
  });
}
