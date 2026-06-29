import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sseEventBus } from '@/lib/events';

interface OrderEvent {
  id: string;
  status?: string;
}

export function useRealtimeOrders(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const unsubscribe = sseEventBus.subscribe((event) => {
      if (event.type === 'order.created') {
        qc.invalidateQueries({ queryKey: ['orders', 'byStatus'] });
        qc.invalidateQueries({ queryKey: ['orders', 'stats'] });
        // Badges & dashboard react to new orders too.
        qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
      }

      if (event.type === 'order.updated') {
        const payload = event.payload as OrderEvent;
        qc.invalidateQueries({ queryKey: ['orders', 'byStatus'] });
        qc.invalidateQueries({ queryKey: ['orders', 'detail', payload.id] });
      }

      if (event.type === 'message.flagged') {
        qc.invalidateQueries({ queryKey: ['messages'] });
        qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
      }

      if (event.type === 'payment.confirmed') {
        qc.invalidateQueries({ queryKey: ['payments'] });
        qc.invalidateQueries({ queryKey: ['orders'] });
        qc.invalidateQueries({ queryKey: ['customers'] });
      }

      if (event.type === 'stock.alert') {
        qc.invalidateQueries({ queryKey: ['products', 'low-stock'] });
        qc.invalidateQueries({ queryKey: ['dashboard', 'badges'] });
      }
    });

    return unsubscribe;
  }, [qc]);
}
