import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OrderUpdatedPayload } from '@flowdesk/shared';
import { sseEventBus } from '@/lib/events';

/**
 * Turns realtime events into cache invalidations.
 *
 * Invalidations are batched on a short timer rather than issued per event: a
 * webhook burst (a catalog import, a payment provider retrying) would otherwise
 * fire one refetch per event per key, and several of these keys are shared, so
 * the same query would be refetched repeatedly within a few milliseconds.
 */

/** Long enough to absorb a burst, short enough to feel immediate. */
const INVALIDATE_DEBOUNCE_MS = 120;

export function useRealtimeOrders(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush(): void {
      flushTimer = null;

      for (const serialized of pending) {
        qc.invalidateQueries({ queryKey: JSON.parse(serialized) as unknown[] });
      }

      pending.clear();
    }

    function queueInvalidate(queryKey: unknown[]): void {
      pending.add(JSON.stringify(queryKey));
      flushTimer ??= setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
    }

    const unsubscribe = sseEventBus.subscribe((event) => {
      if (event.type === 'order.created') {
        queueInvalidate(['orders', 'byStatus']);
        queueInvalidate(['orders', 'stats']);
        // Badges & dashboard react to new orders too.
        queueInvalidate(['dashboard', 'badges']);
      }

      if (event.type === 'order.updated') {
        // The API sends `orderId`; this previously read `payload.id`, so the
        // detail key resolved to `undefined` and an open drawer never updated.
        const payload = event.payload as OrderUpdatedPayload;
        queueInvalidate(['orders', 'byStatus']);
        queueInvalidate(['orders', 'stats']);
        queueInvalidate(['orders', 'detail', payload.orderId]);
        // The nav badge counts pending orders, so any transition into or out of
        // PENDING changes it. Without this the badge kept showing a count for a
        // column the board had already emptied.
        queueInvalidate(['dashboard', 'badges']);
      }

      if (event.type === 'message.flagged') {
        queueInvalidate(['messages']);
        queueInvalidate(['dashboard', 'badges']);
        // A flagged message is very often a MoMo screenshot arriving, and the
        // payment claim behind it is written in the same transaction. Without
        // this the review queue only picks it up on the next stale refetch, so
        // the owner sits looking at a tab that says nothing needs checking
        // while the customer waits to hear their money landed.
        queueInvalidate(['payments', 'review-queue']);
      }

      if (event.type === 'payment.confirmed') {
        queueInvalidate(['payments']);
        queueInvalidate(['payments', 'review-queue']);
        queueInvalidate(['orders']);
        queueInvalidate(['customers']);
      }

      if (event.type === 'stock.alert') {
        queueInvalidate(['products', 'low-stock']);
        queueInvalidate(['dashboard', 'badges']);
      }
    });

    return () => {
      unsubscribe();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [qc]);
}
