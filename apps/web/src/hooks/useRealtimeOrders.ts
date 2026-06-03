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
        // Toast notification for new order — integrate toast library here
      }

      if (event.type === 'order.updated') {
        const payload = event.payload as OrderEvent;
        qc.invalidateQueries({ queryKey: ['orders', 'byStatus'] });
        qc.invalidateQueries({ queryKey: ['orders', 'detail', payload.id] });
      }
    });

    return unsubscribe;
  }, [qc]);
}
