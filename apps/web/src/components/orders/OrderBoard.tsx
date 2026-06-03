import { useDroppable, useDraggable, DndContext, type DragEndEvent } from '@dnd-kit/core';
import { useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import type { OrderWithRelations, OrderStatus } from '@/types/order';
import { useOrdersByStatus, useUpdateOrderStatus } from '@/hooks/useOrders';
import { formatCurrency } from '@/lib/utils';
import OrderCard from './OrderCard';
import EmptyState from '@/components/shared/EmptyState';

const COLUMNS: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'FULFILLED'];

function OrderCardDraggable({ order, onClick }: { order: OrderWithRelations; onClick: (o: OrderWithRelations) => void }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: order.id, data: { order } });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 }
    : { opacity: isDragging ? 0.5 : 1 };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing">
      <OrderCard order={order} onClick={onClick} />
    </div>
  );
}

function KanbanColumn({
  status,
  onSelectOrder,
}: {
  status: OrderStatus;
  onSelectOrder: (order: OrderWithRelations) => void;
}): React.JSX.Element {
  const { data: orders, isLoading, error } = useOrdersByStatus(status);
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const { count, totalValue } = useMemo(() => {
    const list = orders ?? [];
    return {
      count: list.length,
      totalValue: list.reduce((sum, o) => sum + (o.totalAmount ?? 0), 0),
    };
  }, [orders]);

  const sortedOrders = useMemo(() => {
    if (!orders) return [];
    return [...orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [orders]);

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col rounded-[var(--radius-md)] border ${
        isOver ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]' : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      } transition-colors`}
      style={{ maxHeight: 'calc(100vh - 180px)' }}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-primary)]">
            {status}
          </span>
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--color-surface-elevated)] px-1.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
            {count}
          </span>
        </div>
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          {formatCurrency(totalValue)}
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {isLoading && (
          <>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-[120px] animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]"
              />
            ))}
          </>
        )}

        {error && (
          <div className="py-4 text-center text-sm text-[var(--color-danger)]">
            Failed to load orders
          </div>
        )}

        {!isLoading && !error && sortedOrders.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            title={`No ${status.toLowerCase()} orders`}
            description="Orders in this status will appear here."
          />
        )}

        {!isLoading && !error && sortedOrders.map((order) => (
          <OrderCardDraggable key={order.id} order={order} onClick={onSelectOrder} />
        ))}
      </div>
    </div>
  );
}

interface OrderBoardProps {
  onSelectOrder: (order: OrderWithRelations) => void;
}

export default function OrderBoard({ onSelectOrder }: OrderBoardProps): React.JSX.Element {
  const updateStatus = useUpdateOrderStatus();

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over) return;

    const newStatus = over.id as OrderStatus;
    const orderId = active.id as string;

    if (active.data.current?.order?.status === newStatus) return;

    updateStatus.mutate({ orderId, data: { status: newStatus } });
  };

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((status) => (
          <KanbanColumn key={status} status={status} onSelectOrder={onSelectOrder} />
        ))}
      </div>
    </DndContext>
  );
}
