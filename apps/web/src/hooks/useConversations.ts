import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseInfiniteQueryResult, UseQueryResult, InfiniteData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { sseEventBus } from '@/lib/events';

/** One row of the inbox — a customer, not a message. */
export interface ConversationRow {
  customerId: string;
  name: string | null;
  waNumber: string;
  preview: { body: string | null; fromShop: boolean; at: string } | null;
  /** Flagged customer messages nobody from the shop has answered since. */
  waiting: number;
  needsYou: boolean;
  lastActivityAt: string;
  inbox: InboxState | null;
}

export interface InboxState {
  assignee: { id: string; name: string } | null;
  revision: number;
  unread: number;
  manuallyUnread: boolean;
  inboundPosition: string;
  readPosition: string;
  readRevision: number;
}

interface ConversationPage {
  conversations: ConversationRow[];
  nextCursor: string | null;
}

export interface ThreadMessage {
  hasAttachment?: boolean;
  id: string;
  body: string | null;
  type: string;
  fromShop: boolean;
  /** Recorded only where the database knows; see the API for why it can be null. */
  sentBy: 'phone' | 'staff' | null;
  needsYou: boolean;
  /** An assistant suggestion awaiting the owner's approval, or null. */
  draft: string | null;
  deliveryState?: string;
  createdAt: string;
}

export interface Thread {
  customer: { id: string; name: string | null; waNumber: string };
  messages: ThreadMessage[];
  nextBefore: string | null;
  inbox?: InboxState;
}

export type InboxFilter = 'all' | 'needs_you' | 'unread';
export type AssignmentFilter = 'all' | 'assigned' | 'unassigned' | 'mine';

/** Rows fetched per page. Enough to fill a tall screen without paging on load. */
const PAGE_SIZE = 40;

/**
 * How often the inbox checks for new messages on its own.
 *
 * The realtime stream announces only FLAGGED messages, not every one, so a
 * conversation the assistant handled would otherwise not move to the top until
 * the owner navigated away and back. Fifteen seconds is quick enough that a
 * customer who has just written is visibly there, and slow enough that an
 * inbox left open all day is not a load on the API.
 */
const POLL_MS = 15_000;

export function useConversations(
  filter: InboxFilter,
  q: string,
  assignment: AssignmentFilter,
): UseInfiniteQueryResult<InfiniteData<ConversationPage>, Error> {
  return useInfiniteQuery({
    queryKey: ['conversations', filter, q, assignment],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter, assignment, limit: String(PAGE_SIZE) });
      if (q.trim()) params.set('q', q.trim());
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch<ConversationPage>(`/conversations?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: POLL_MS,
    staleTime: 5_000,
  });
}

export function useThread(customerId: string | null): UseQueryResult<Thread, Error> {
  return useQuery({
    queryKey: ['conversations', 'thread', customerId],
    queryFn: () => apiFetch<Thread>(`/conversations/${encodeURIComponent(customerId ?? '')}`),
    enabled: customerId !== null,
    refetchInterval: POLL_MS,
    staleTime: 5_000,
  });
}

/**
 * Refreshes the inbox the moment something is flagged for the owner.
 *
 * Polling covers ordinary traffic; a flagged message is the one thing an owner
 * is waiting to see, so it should not sit for up to fifteen seconds first.
 */
export function useInboxRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const unsubscribe = sseEventBus.subscribe((event) => {
      if (event.type === 'message.flagged' || event.type === 'inbox.changed') {
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
      }
    });
    return unsubscribe;
  }, [qc]);
}
