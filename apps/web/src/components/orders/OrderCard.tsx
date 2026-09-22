import { AlertTriangle } from 'lucide-react';
import type { OrderWithRelations } from '@/types/order';
import { formatCurrency, timeAgo, getInitials, customerLabel, formatPhone } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface OrderCardProps {
  order: OrderWithRelations;
  onClick: (order: OrderWithRelations) => void;
  /** On the board the column already states the status, so the tag is dropped. */
  showStatus?: boolean;
}

// Typed as `Record<string, string>`, so a missing status is not a build error —
// it simply renders as nothing on the card. DISPATCHED went missing here when
// the status was added to the enum, which is exactly the failure this type can
// never catch.
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  DISPATCHED: 'Dispatched',
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
};

/**
 * A single order, as it appears on the board and in the mobile list.
 *
 * The old card repeated the status as a coloured tag in the corner while
 * sitting inside a column headed by that same status, and set the reference
 * number in the brand colour at the same size as the customer's name, so the
 * loudest thing on the card was an internal identifier.
 *
 * Now the money is the largest element, the customer is second, and the
 * reference is quiet metadata. The only thing allowed to interrupt that is a
 * customer who already owes money, because taking a new order from someone
 * with an unpaid balance is a decision, not a formality.
 */
export default function OrderCard({
  order,
  onClick,
  showStatus = false,
}: OrderCardProps): React.JSX.Element {
  const items = order.items ?? [];
  const topItems = items.slice(0, 2);
  const remaining = items.length - topItems.length;
  const outstanding = order.customer.outstandingBalance ?? 0;
  const hasOutstanding = outstanding > 0;

  return (
    <button
      type="button"
      onClick={() => onClick(order)}
      className={cn(
        'flex w-full flex-col gap-2.5 rounded-md border border-border bg-surface p-3 text-left',
        'transition-[border-color,box-shadow] duration-fast ease-out',
        '[@media(hover:hover)and(pointer:fine)]:hover:border-border-strong',
        '[@media(hover:hover)and(pointer:fine)]:hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="fd-figure truncate text-2xs text-text-muted">{order.referenceNumber}</span>
        <span className="shrink-0 text-2xs text-text-muted">{timeAgo(order.createdAt)}</span>
      </div>

      {/*
        `customerLabel` rather than the raw fields. It falls back to a readable
        +233 XX XXX XXXX when a customer has not given a name — which is most
        new customers — where this used to print twelve undifferentiated digits
        an owner cannot match against their phone or read out to a rider. It
        also refuses a profile name that is only an emoji.

        The number line shows only when the line above it is an actual name,
        since otherwise the two say the same thing twice.
      */}
      <div className="flex flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text-primary">
          {customerLabel(order.customer, 'Unknown customer')}
        </span>
        {order.customer.name && (
          <span className="fd-figure truncate text-2xs text-text-muted">
            {formatPhone(order.customer.waNumber)}
          </span>
        )}
      </div>

      {topItems.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {topItems.map((item) => (
            <li key={item.id} className="truncate text-xs text-text-secondary">
              <span className="fd-figure text-text-muted">{item.quantity}×</span> {item.description}
            </li>
          ))}
          {remaining > 0 && (
            <li className="text-xs text-text-muted">
              and {remaining} more item{remaining === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      )}

      {hasOutstanding && (
        <p className="flex items-center gap-1.5 rounded-sm bg-danger-muted px-1.5 py-1 text-2xs font-medium text-danger">
          <AlertTriangle className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
          Owes {formatCurrency(outstanding)} already
        </p>
      )}

      <div className="flex items-end justify-between gap-2 border-t border-border-subtle pt-2.5">
        <span className="fd-figure text-base font-semibold leading-none text-text-primary">
          {formatCurrency(order.totalAmount)}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {showStatus && (
            <span className="text-2xs font-medium text-text-muted">
              {STATUS_LABEL[order.status] ?? order.status}
            </span>
          )}
          {order.assignedTo && (
            <span
              className="flex h-5 w-5 items-center justify-center rounded-sm bg-surface-sunken text-[10px] font-semibold text-text-secondary"
              title={`Assigned to ${order.assignedTo.name}`}
            >
              {getInitials(order.assignedTo.name)}
              <span className="sr-only">Assigned to {order.assignedTo.name}</span>
            </span>
          )}
        </span>
      </div>
    </button>
  );
}
