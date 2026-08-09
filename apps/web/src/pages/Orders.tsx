import { useMemo, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { OrderWithRelations, OrderStatus } from '@/types/order';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import OrderBoard from '@/components/orders/OrderBoard';
import OrderDetailDrawer from '@/components/orders/OrderDetailDrawer';
import ManualOrderModal from '@/components/orders/ManualOrderModal';
import { useOrdersByStatus } from '@/hooks/useOrders';
import { useStaff } from '@/hooks/useStaff';
import OrderCard from '@/components/orders/OrderCard';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import { InlineSelect } from '@/components/ui/Field';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { SkeletonCards } from '@/components/ui/Skeleton';
import { useTabParam } from '@/hooks/useTabParam';
import { useIsDesktop } from '@/hooks/useMediaQuery';

const TAB_OPTIONS: readonly TabOption<OrderStatus>[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PROCESSING', label: 'Packing' },
  { value: 'FULFILLED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const ORDER_TAB_VALUES = TAB_OPTIONS.map((t) => t.value);

const EMPTY_COPY: Record<OrderStatus, string> = {
  PENDING: 'Nothing waiting to be confirmed.',
  CONFIRMED: 'Nothing confirmed yet.',
  PROCESSING: 'Nothing being packed.',
  FULFILLED: 'Nothing delivered yet.',
  CANCELLED: 'Nothing cancelled.',
};

function MobileOrderList({
  status,
  staffId,
  onSelectOrder,
}: {
  status: OrderStatus;
  staffId: string;
  onSelectOrder: (order: OrderWithRelations) => void;
}): React.JSX.Element {
  const { data: orders, isLoading } = useOrdersByStatus(status, staffId || undefined);

  const sorted = useMemo(
    () =>
      [...(orders ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [orders],
  );

  if (isLoading) return <SkeletonCards count={3} />;

  if (!sorted.length) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Nothing here"
        description={EMPTY_COPY[status]}
        className="px-0"
      />
    );
  }

  return (
    <div className="fd-stagger space-y-2.5">
      {sorted.map((order) => (
        <OrderCard key={order.id} order={order} onClick={onSelectOrder} showStatus />
      ))}
    </div>
  );
}

export default function OrdersPage(): React.JSX.Element {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useTabParam<OrderStatus>('status', ORDER_TAB_VALUES, 'PENDING');
  const [staffId, setStaffId] = useState('');
  const isDesktop = useIsDesktop();

  const { data: staffList = [] } = useStaff();
  useRealtimeOrders();

  const handleSelectOrder = (order: OrderWithRelations): void => {
    setSelectedOrderId(order.id);
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <PageHeader
        title="Orders"
        description="Drag an order along as it moves."
        actions={
          <>
            <InlineSelect
              aria-label="Filter orders by assigned staff member"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
            >
              <option value="">Everyone</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </InlineSelect>
            <ManualOrderModal />
          </>
        }
      />

      {/* Board on desktop, one status at a time on a phone. A five-column
          board on a 360px screen is unusable, and a horizontally scrolling
          board is worse: you lose track of which column you are in.

          Branched on a media query rather than `hidden md:flex`, because CSS
          visibility still mounts both trees: the board opens one query per
          column, so every phone was fetching all five lists it would never
          show, on the mid-range Android connection this is built for. */}
      {isDesktop ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <OrderBoard onSelectOrder={handleSelectOrder} staffId={staffId} />
        </div>
      ) : (
        <div>
          <Tabs
            label="Filter orders by status"
            options={TAB_OPTIONS}
            value={activeTab}
            onChange={setActiveTab}
          />
          <div className="mt-4">
            <MobileOrderList
              status={activeTab}
              staffId={staffId}
              onSelectOrder={handleSelectOrder}
            />
          </div>
        </div>
      )}

      <OrderDetailDrawer orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
    </div>
  );
}
