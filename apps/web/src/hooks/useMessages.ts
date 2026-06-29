import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

export function useMessages(requiresReview?: boolean) {
  const query = requiresReview ? '?requiresReview=true' : '';
  return useQuery({
    queryKey: ['messages', requiresReview],
    queryFn: () => fetchJson<Message[]>(`/messages${query}`),
    staleTime: 30_000,
  });
}

/**
 * Manually reclassify a message's intent. Use this from the review queue —
 * it records who made the correction (for the IntentCorrection log) and flips
 * requiresReview→false once a confident intent is picked.
 */
export function useCorrectMessageIntent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, intent }: { id: string; intent: string }) =>
      fetchJson<Message>(`/messages/${id}/intent`, {
        method: 'PATCH',
        body: JSON.stringify({ intent }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
    },
  });
}
