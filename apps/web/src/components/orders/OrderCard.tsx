import { AlertTriangle } from 'lucide-react';
import type { OrderWithRelations } from '@/types/order';
import { formatCurrency, timeAgo, getInitials } from '@/lib/utils';

interface OrderCardProps {
  order: OrderWithRelations;
  onClick: (order: OrderWithRelations) => void;
}

const statusBadgeMap: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'bg-[var(--color-warning-muted)]', text: 'text-[var(--color-warning)]' },
  CONFIRMED: { bg: 'bg-[var(--color-info-muted)]', text: 'text-[var(--color-info)]' },
  PROCESSING: { bg: 'bg-[var(--color-primary-muted)]', text: 'text-[var(--color-primary-light)]' },
  FULFILLED: { bg: 'bg-[var(--color-success-muted)]', text: 'text-[var(--color-success)]' },
  CANCELLED: { bg: 'bg-[var(--color-danger-muted)]', text: 'text-[var(--color-danger)]' },
};

export default function OrderCard({ order, onClick }: OrderCardProps): React.JSX.Element {
  const badge = statusBadgeMap[order.status] ?? { bg: 'bg-[var(--color-warning-muted)]', text: 'text-[var(--color-warning)]' };
  const items = order.items ?? [];
  const topItems = items.slice(0, 2);
  const remaining = items.length - topItems.length;
  const outstanding = order.customer.outstandingBalance ?? 0;
  const hasOutstanding = outstanding > 0;

  return (
    <button
      onClick={() => onClick(order)}
      className="flex w-full flex-col gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-3 text-left transition-all hover:border-[var(--color-primary-border)] hover:shadow-md hover:shadow-black/20"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-sm font-semibold text-[var(--color-primary-light)]">
          {order.referenceNumber}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {timeAgo(order.createdAt)}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">
          {order.customer.name ?? 'Unknown'}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {order.customer.waNumber}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        {topItems.map((item) => (
          <span key={item.id} className="truncate text-xs text-[var(--color-text-secondary)]">
            {item.description} × {item.quantity}
          </span>
        ))}
        {remaining > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">
            and {remaining} more
          </span>
        )}
      </div>

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          {order.assignedTo && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary-muted)] text-[10px] font-semibold text-[var(--color-primary-light)]">
              {getInitials(order.assignedTo.name)}
            </div>
          )}
          {hasOutstanding && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-danger-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
              <AlertTriangle className="h-3 w-3" />
              owes {formatCurrency(outstanding)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-[var(--color-text-primary)]">
            {formatCurrency(order.totalAmount)}
          </span>
          <span className={`inline-flex rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge.bg} ${badge.text}`}>
            {order.status}
          </span>
        </div>
      </div>
    </button>
  );
}
