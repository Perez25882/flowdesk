import type { OrderWithRelations } from '@/types/order';
import { STATUS_META } from '@/components/orders/status';
import { cn, customerLabel, formatCurrency, formatPhone, timeAgo } from '@/lib/utils';

/**
 * Orders as rows, for when there are too many for cards.
 *
 * The board is the right tool for the dozen orders moving through the shop
 * today. It is the wrong tool for the two hundred behind them: six columns of
 * cards stop being scannable long before that, and a board cannot be searched
 * or paged. This is the view an owner uses to find "the one Ama placed last
 * Tuesday", so it is built for scanning down a column — reference, who, what,
 * how much, where it is, when.
 *
 * Each row is a button laid out on a grid rather than a table row with a click
 * handler: a clickable <tr> cannot be reached by keyboard, and the same markup
 * stacks into a readable block on a phone.
 */

const GRID =
  'md:grid md:grid-cols-[6.5rem_minmax(0,1.3fr)_minmax(0,1.6fr)_7.5rem_8rem_5rem] md:items-center md:gap-4';

export default function OrderTable({
  orders,
  onSelect,
}: {
  orders: OrderWithRelations[];
  onSelect: (order: OrderWithRelations) => void;
}): React.JSX.Element {
  return (
    <div role="list" aria-label="Orders">
      <div
        aria-hidden="true"
        className={cn(
          GRID,
          'hidden border-b border-border px-4 py-2 text-2xs font-medium text-text-muted',
        )}
      >
        <span>Order</span>
        <span>Customer</span>
        <span>Items</span>
        <span className="text-right">Total</span>
        <span>Status</span>
        <span className="text-right">Placed</span>
      </div>

      <div className="divide-y divide-border">
        {orders.map((order) => (
          <OrderRow key={order.id} order={order} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function OrderRow({
  order,
  onSelect,
}: {
  order: OrderWithRelations;
  onSelect: (order: OrderWithRelations) => void;
}): React.JSX.Element {
  // Decimal columns arrive from the API as strings despite the type; see the
  // column-total fix on the board for what happens when they are added raw.
  const total = Number(order.totalAmount ?? 0);
  const paid = Number(order.amountPaid ?? 0);
  const owed = total - paid;
  const cancelled = order.status === 'CANCELLED';
  const status = STATUS_META[order.status];

  const items = order.items ?? [];
  const first = items[0];
  const itemsLabel = first
    ? `${first.quantity}× ${first.description}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
    : 'No items';

  const phone = formatPhone(order.customer.waNumber);
  const hasName = customerLabel(order.customer) !== phone;

  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onSelect(order)}
      className={cn(
        GRID,
        'flex w-full flex-col gap-1 px-4 py-3 text-left',
        'transition-colors duration-fast ease-out',
        '[@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        cancelled && 'opacity-60',
      )}
    >
      {/* Phone: reference and status share the first line, the way a person
          reads a slip — which order, and where is it. */}
      <span className="flex items-center justify-between gap-3 md:contents">
        <span className="fd-figure text-xs font-medium text-text-secondary">
          {order.referenceNumber}
        </span>
        <StatusLabel dot={status.dot} label={status.label} className="md:hidden" />
      </span>

      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">
          {customerLabel(order.customer, 'Unknown customer')}
        </span>
        {hasName && (
          <span className="fd-figure block truncate text-2xs text-text-muted">{phone}</span>
        )}
      </span>

      <span className="truncate text-xs text-text-secondary">{itemsLabel}</span>

      <span className="flex items-baseline justify-between md:block md:text-right">
        <span className="fd-figure text-sm font-semibold text-text-primary">
          {formatCurrency(total)}
        </span>
        {!cancelled && paid > 0 && owed > 0 && (
          <span className="fd-figure block text-2xs text-text-muted">
            {formatCurrency(owed)} to pay
          </span>
        )}
        {!cancelled && paid > 0 && owed <= 0 && (
          <span className="block text-2xs text-text-muted">Paid</span>
        )}
      </span>

      <StatusLabel dot={status.dot} label={status.label} className="hidden md:flex" />

      <span className="text-2xs text-text-muted md:text-right">{timeAgo(order.createdAt)}</span>
    </button>
  );
}

function StatusLabel({
  dot,
  label,
  className,
}: {
  dot: string;
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('flex items-center gap-1.5 text-xs text-text-secondary', className)}>
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
      {label}
    </span>
  );
}
