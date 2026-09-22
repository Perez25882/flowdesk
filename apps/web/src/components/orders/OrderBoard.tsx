import {
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMemo } from 'react';
import type { OrderWithRelations, OrderStatus } from '@/types/order';
import { useOrdersByStatus, useUpdateOrderStatus } from '@/hooks/useOrders';
import { formatCurrency, cn } from '@/lib/utils';
import OrderCard from './OrderCard';
import { SkeletonCards } from '@/components/ui/Skeleton';

/**
 * The order board.
 *
 * The previous version gave all five statuses identical columns of identical
 * width, which said that a cancelled order deserves as much of the screen as
 * an order waiting to be confirmed. It does not. Pending is the work; the rest
 * is history.
 *
 * So the columns are weighted: Pending is widest and carries an accent rule,
 * Cancelled is narrowest and visually recedes. On a 1440px screen that is the
 * difference between five cramped 250px columns and a board you can actually
 * read from across the shop.
 */

/**
 * Column widths are set on the grid container, in the same order as this list.
 * Attention, expressed as width: 1.25 / 1.1 / 1.1 / 1 / 0.8.
 */
const COLUMNS: {
  status: OrderStatus;
  label: string;
  accent: string;
}[] = [
  { status: 'PENDING', label: 'Pending', accent: 'bg-status-pending' },
  { status: 'CONFIRMED', label: 'Confirmed', accent: 'bg-status-confirmed' },
  { status: 'PROCESSING', label: 'Packing', accent: 'bg-status-processing' },
  { status: 'DISPATCHED', label: 'On the way', accent: 'bg-status-dispatched' },
  { status: 'FULFILLED', label: 'Delivered', accent: 'bg-status-fulfilled' },
  { status: 'CANCELLED', label: 'Cancelled', accent: 'bg-status-cancelled' },
];

/**
 * CANCELLED is a terminal state, orders there should not be draggable.
 */
function OrderCardDraggable({
  order,
  onClick,
  draggable,
}: {
  order: OrderWithRelations;
  onClick: (o: OrderWithRelations) => void;
  draggable: boolean;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    data: { order },
    disabled: !draggable,
  });

  // Full transform string rather than dnd-kit's shorthand, so the browser
  // promotes it to the compositor and the card does not judder while the
  // query cache is busy behind it.
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scale(1.02)`
      : undefined,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(draggable ? { ...listeners, ...attributes } : {})}
      className={cn(
        'touch-manipulation',
        draggable && 'cursor-grab active:cursor-grabbing',
        // Only the drag itself is transitioned, and only while not dragging,
        // so releasing a card settles rather than snapping.
        !isDragging && 'transition-transform duration-fast ease-out',
      )}
    >
      <OrderCard order={order} onClick={onClick} />
    </div>
  );
}

function KanbanColumn({
  status,
  label,
  accent,
  onSelectOrder,
  isDropTarget,
  staffId,
}: {
  status: OrderStatus;
  label: string;
  accent: string;
  onSelectOrder: (order: OrderWithRelations) => void;
  isDropTarget: boolean;
  staffId: string;
}): React.JSX.Element {
  const { data: orders, isLoading, error } = useOrdersByStatus(status, staffId || undefined);
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !isDropTarget });

  const { count, totalValue } = useMemo(() => {
    const list = orders ?? [];
    return {
      count: list.length,
      // `Number(...)`, because `totalAmount` is typed `number` here but arrives
      // as a STRING: it is a Prisma `Decimal`, and the orders list serialises
      // the row straight to JSON without converting it. `0 + "240"` is "0240",
      // and eight orders of GHS 240 became a column total in the quadrillions.
      // The type said number, so nothing caught it.
      totalValue: list.reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0),
    };
  }, [orders]);

  const sortedOrders = useMemo(() => {
    if (!orders) return [];
    return [...orders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [orders]);

  const isTerminal = status === 'CANCELLED';

  return (
    <section
      ref={isDropTarget ? setNodeRef : undefined}
      aria-label={`${label}, ${count} orders`}
      className={cn(
        'flex min-h-0 flex-col rounded-lg border transition-colors duration-fast ease-out',
        isOver
          ? 'border-primary bg-primary-muted'
          : isTerminal
            ? 'border-border-subtle bg-surface-sunken/60'
            : 'border-border bg-surface',
      )}
    >
      <header className="shrink-0 border-b border-border-subtle px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {/* A hue chip rather than coloured text: the label stays at full
                contrast and the colour still identifies the column. */}
            <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', accent)} />
            <span
              className={cn(
                'truncate text-sm font-semibold',
                isTerminal ? 'text-text-muted' : 'text-text-primary',
              )}
            >
              {label}
            </span>
            <span className="fd-figure shrink-0 text-xs text-text-muted">{count}</span>
          </span>
        </div>

        {/* The column total is what makes a board a ledger. Hidden when zero,
            because "GHS 0.00" five times across the top is just noise. */}
        {totalValue > 0 && (
          <span className="fd-figure mt-0.5 block text-xs text-text-secondary">
            {formatCurrency(totalValue)}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {isLoading && <SkeletonCards count={2} />}

        {error && (
          <p className="px-1 py-3 text-sm text-danger">
            Could not load these orders. Check your connection and try again.
          </p>
        )}

        {!isLoading && !error && sortedOrders.length === 0 && (
          <p className="px-1 py-6 text-xs text-text-muted">Nothing here.</p>
        )}

        {!isLoading &&
          !error &&
          sortedOrders.map((order) => (
            <OrderCardDraggable
              key={order.id}
              order={order}
              onClick={onSelectOrder}
              draggable={!isTerminal}
            />
          ))}
      </div>
    </section>
  );
}

interface OrderBoardProps {
  onSelectOrder: (order: OrderWithRelations) => void;
  staffId: string;
}

export default function OrderBoard({ onSelectOrder, staffId }: OrderBoardProps): React.JSX.Element {
  const updateStatus = useUpdateOrderStatus();

  /**
   * Sensors with activation constraints, because the defaults make the board
   * unusable.
   *
   * dnd-kit's default PointerSensor begins a drag on pointerdown with no
   * threshold, and a drag suppresses the click that follows. The cards are
   * buttons whose click opens the order, so with the defaults, clicking an
   * order on the board did nothing at all. The only way into an order was the
   * dashboard's list. Tapping on a phone was worse: the tap started a drag, and
   * on mobile the board is a tabbed list with nothing to drag to.
   *
   * A pointer has to travel 8px before it counts as a drag, which is under the
   * distance a hand moves during a deliberate drag and over the distance it
   * moves during a click. Touch gets a hold instead of a distance: a distance
   * threshold on touch would capture the vertical swipe that scrolls the
   * column, so a quarter-second hold is what separates "I am moving this card"
   * from "I am scrolling" or "I am opening this".
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over) return;

    const newStatus = over.id as OrderStatus;
    const orderId = active.id as string;

    if (active.data.current?.order?.status === newStatus) return;

    // Drop on CANCELLED = intentional cancel. Pass a note so the history
    // records a reason.
    const note = newStatus === 'CANCELLED' ? 'Cancelled from the board' : undefined;
    updateStatus.mutate({ orderId, data: { status: newStatus, ...(note ? { note } : {}) } });
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div
        className={cn(
          'grid min-h-0 flex-1 gap-3 md:grid-cols-2 lg:grid-cols-3',
          // The weighting only applies once all five fit side by side. Written
          // as a CSS class rather than measured in JS, so it responds to a
          // resize without a listener and costs nothing at runtime.
          'xl:[grid-template-columns:1.25fr_1.1fr_1.1fr_1fr_0.8fr]',
        )}
        style={{ maxHeight: 'calc(100dvh - 15rem)' }}
      >
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column.status}
            status={column.status}
            label={column.label}
            accent={column.accent}
            onSelectOrder={onSelectOrder}
            isDropTarget={column.status !== 'CANCELLED'}
            staffId={staffId}
          />
        ))}
      </div>
    </DndContext>
  );
}
