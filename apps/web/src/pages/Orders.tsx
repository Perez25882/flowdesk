import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, LayoutGrid, Rows3 } from 'lucide-react';
import type { OrderStatus } from '@/types/order';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import OrderBoard from '@/components/orders/OrderBoard';
import OrderTable from '@/components/orders/OrderTable';
import OrderDetailDrawer from '@/components/orders/OrderDetailDrawer';
import ManualOrderModal from '@/components/orders/ManualOrderModal';
import { ORDER_STATUS_ORDER, STATUS_META } from '@/components/orders/status';
import {
  useOrderCounts,
  useOrderList,
  ORDER_PAGE_SIZE,
  type OrderListFilter,
} from '@/hooks/useOrders';
import { useStaff } from '@/hooks/useStaff';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import SearchInput from '@/components/ui/SearchInput';
import { InlineSelect } from '@/components/ui/Field';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

type View = 'list' | 'board';

const EMPTY_COPY: Record<OrderListFilter, string> = {
  ALL: 'Orders appear here as customers place them on WhatsApp.',
  PENDING: 'Nothing waiting to be confirmed.',
  CONFIRMED: 'Nothing confirmed yet.',
  PROCESSING: 'Nothing being packed.',
  DISPATCHED: 'Nothing on the way.',
  FULFILLED: 'Nothing delivered yet.',
  CANCELLED: 'Nothing cancelled.',
};

/**
 * Orders.
 *
 * The board was the only view, and it does not scale. Each column fetched the
 * API's default page of 20 without saying so, so a shop with 180 pending orders
 * saw a column headed "20" and the rest were on screen nowhere — not further
 * down, not behind a "more" link, nowhere. A board also cannot be searched,
 * which is what an owner actually needs when a customer rings about an order
 * from last Tuesday.
 *
 * So the list is the default: searchable, paged, and honest about how many
 * orders there are. The board stays, because dragging an order along as it
 * moves is genuinely the best way to work through today's dozen — it is now a
 * choice rather than the only option.
 */
export default function OrdersPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState('');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search, 250);

  const view: View = params.get('view') === 'board' ? 'board' : 'list';
  const status = (params.get('status') ?? 'ALL') as OrderListFilter;
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const { data: staffList = [] } = useStaff();
  useRealtimeOrders();

  const counts = useOrderCounts({ search: query, staffId: staffId || undefined });
  const list = useOrderList({ status, search: query, page, staffId: staffId || undefined });

  function update(next: Record<string, string | null>): void {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged);
  }

  const tabs: TabOption<OrderListFilter>[] = [
    { value: 'ALL', label: 'All', ...(counts.data ? { count: counts.data.ALL } : {}) },
    ...ORDER_STATUS_ORDER.map((value: OrderStatus) => ({
      value: value as OrderListFilter,
      label: STATUS_META[value].label,
      ...(counts.data ? { count: counts.data[value as OrderListFilter] } : {}),
    })),
  ];

  const meta = list.data?.meta;
  const orders = list.data?.data ?? [];
  const from = meta && meta.total > 0 ? (meta.page - 1) * ORDER_PAGE_SIZE + 1 : 0;
  const to = meta ? Math.min(meta.page * ORDER_PAGE_SIZE, meta.total) : 0;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <PageHeader
        title="Orders"
        description={
          view === 'board' ? 'Drag an order along as it moves.' : 'Every order, newest first.'
        }
        actions={
          <>
            <ViewToggle view={view} onChange={(next) => update({ view: next, page: null })} />
            <InlineSelect
              aria-label="Filter orders by assigned staff member"
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
            >
              <option value="">Everyone</option>
              {staffList.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </InlineSelect>
            <ManualOrderModal />
          </>
        }
      />

      {view === 'board' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <OrderBoard onSelectOrder={(order) => setSelectedOrderId(order.id)} staffId={staffId} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
          <div className="space-y-3 border-b border-border px-4 pt-3">
            <SearchInput
              value={search}
              onChange={(next) => {
                setSearch(next);
                // A new search restarts at the first page; staying on page 7 of
                // the old results would show an empty table.
                if (page !== 1) update({ page: null });
              }}
              placeholder="Search by order number, customer or phone"
              label="Search orders"
            />
            <Tabs
              options={tabs}
              value={status}
              onChange={(next) => update({ status: next, page: null })}
              label="Filter orders by status"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isLoading ? (
              <SkeletonRows count={8} className="p-4" />
            ) : list.error ? (
              <div className="m-4 rounded-md border border-danger/25 bg-danger/5 px-3 py-2.5">
                <p className="text-xs font-medium text-text-primary">Orders didn&apos;t load.</p>
                <button
                  type="button"
                  onClick={() => void list.refetch()}
                  className="mt-1.5 text-2xs font-semibold text-danger underline-offset-2 hover:underline"
                >
                  Try again
                </button>
              </div>
            ) : orders.length === 0 ? (
              query.trim() ? (
                <p className="px-4 py-10 text-center text-sm text-text-muted">
                  No orders match &ldquo;{query}&rdquo;.
                </p>
              ) : (
                <EmptyState
                  icon={ClipboardList}
                  title="Nothing here"
                  description={EMPTY_COPY[status]}
                />
              )
            ) : (
              <OrderTable orders={orders} onSelect={(order) => setSelectedOrderId(order.id)} />
            )}
          </div>

          {meta && meta.total > ORDER_PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-2xs text-text-muted">
                <span className="fd-figure">
                  {from}–{to}
                </span>{' '}
                of <span className="fd-figure">{meta.total}</span>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => update({ page: String(page - 1) })}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => update({ page: String(page + 1) })}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <OrderDetailDrawer orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (next: View) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Choose how orders are shown"
      className="flex rounded-md border border-border p-0.5"
    >
      {(
        [
          { value: 'list', label: 'List', Icon: Rows3 },
          { value: 'board', label: 'Board', Icon: LayoutGrid },
        ] as const
      ).map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={view === value}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium',
            'transition-colors duration-fast ease-out',
            view === value
              ? 'bg-primary-muted text-primary'
              : 'text-text-secondary [@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
