import { useMemo, useState } from 'react';
import type { OrderWithRelations, OrderStatus } from '@/types/order';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import OrderBoard from '@/components/orders/OrderBoard';
import OrderDetailDrawer from '@/components/orders/OrderDetailDrawer';
import ManualOrderModal from '@/components/orders/ManualOrderModal';
import { useOrdersByStatus } from '@/hooks/useOrders';
import { useStaff } from '@/hooks/useStaff';
import OrderCard from '@/components/orders/OrderCard';
import EmptyState from '@/components/shared/EmptyState';
import { ClipboardList } from 'lucide-react';

const TABS: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'FULFILLED', 'CANCELLED'];

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

  const sorted = useMemo(() => {
    return [...(orders ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [orders]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-[100px] animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />
        ))}
     </div>
    );
  }

  if (!sorted.length) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={`No ${status.toLowerCase()} orders`}
        description="Orders will appear here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((order) => (
        <OrderCard key={order.id} order={order} onClick={() => onSelectOrder(order)} />
      ))}
   </div>
  );
}

export default function OrdersPage(): React.JSX.Element {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<OrderStatus>('PENDING');
  const [staffId, setStaffId] = useState('');

  const { data: staffList = [] } = useStaff();
  useRealtimeOrders();

  const handleSelectOrder = (order: OrderWithRelations): void => {
    setSelectedOrderId(order.id);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
        >
          <option value="">All staff</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
           </option>
          ))}
       </select>
        <ManualOrderModal />
     </div>

      {/* Desktop Kanban */}
      <div className="hidden md:block">
        <OrderBoard onSelectOrder={handleSelectOrder} staffId={staffId} />
     </div>

      {/* Mobile Tabs */}
      <div className="md:hidden">
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] pb-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary-light)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              {tab}
           </button>
          ))}
       </div>
        <div className="mt-3">
          <MobileOrderList status={activeTab} staffId={staffId} onSelectOrder={handleSelectOrder} />
       </div>
     </div>

      <OrderDetailDrawer orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
   </div>
  );
}
