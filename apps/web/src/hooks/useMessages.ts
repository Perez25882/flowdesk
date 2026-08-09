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
  /** A reply the assistant wrote for this message, if any. */
  aiReplyText: string | null;
  aiReplyStatus: 'DRAFT' | 'AUTO_SENT' | 'SENT' | 'DISMISSED' | 'SUPERSEDED' | 'EXPIRED' | null;
  /** Guardrail checks the suggestion failed, shown so the owner knows to look. */
  aiValidationFailed: string[];
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

export interface SendReplyResult {
  messageId: string;
  body: string;
  /** True when the owner changed what the assistant proposed. */
  edited: boolean;
}

/**
 * Sends a reply to a customer.
 *
 * The API validates the 24-hour window, the WhatsApp connection and the plan
 * allowance before accepting, so a failure arrives here as a readable message
 * rather than as a silent non-delivery.
 */
export function useSendReply(): UseMutationResult<
  SendReplyResult,
  Error,
  { id: string; body: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      apiFetch<SendReplyResult>(`/messages/${id}/reply`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
    },
  });
}

/** Throws away a suggestion the owner does not want to send. */
export function useDismissDraft(): UseMutationResult<unknown, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch(`/messages/${id}/dismiss-draft`, { method: 'POST', body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}
