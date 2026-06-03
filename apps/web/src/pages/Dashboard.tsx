import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShoppingCart,
  Clock,
  TrendingUp,
  Package,
  MessageSquareWarning,
  Users,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import { useOrdersByStatus, useOrderStats } from '@/hooks/useOrders';
import { useCustomers } from '@/hooks/useCustomers';
import { usePayments } from '@/hooks/usePayments';
import { useMessages } from '@/hooks/useMessages';
import { useLowStockProducts } from '@/hooks/useProducts';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import { isAuthenticated } from '@/hooks/useAuth';
import StatCard from '@/components/shared/StatCard';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency, timeAgo } from '@/lib/utils';

function useAuthGuard(): boolean {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAuthenticated()) {
      navigate('/login', { replace: true });
    }
  }, [navigate]);
  return isAuthenticated();
}

export default function DashboardPage(): React.JSX.Element {
  const authed = useAuthGuard();
  const { data: pendingOrders, isLoading: pendingLoading } = useOrdersByStatus('PENDING');
  const { data: stats } = useOrderStats('today');
  const { data: customers } = useCustomers(undefined, undefined, true);
  const { data: unverifiedPayments } = usePayments(false);
  const { data: reviewMessages } = useMessages(true);
  const { data: lowStockProducts } = useLowStockProducts();

  useRealtimeOrders();

  if (!authed) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      </div>
    );
  }

  const pendingCount = stats?.byStatus?.PENDING ?? pendingOrders?.length ?? 0;
  const pendingValue = pendingOrders?.reduce((sum, o) => sum + (o.totalAmount ?? 0), 0) ?? 0;
  const revenue = stats?.totalRevenue ?? 0;
  const reviewCount = unverifiedPayments?.length ?? 0;
  const topDebtors = [...(customers ?? [])]
    .filter((c) => (c.outstandingBalance ?? 0) > 0)
    .sort((a, b) => (b.outstandingBalance ?? 0) - (a.outstandingBalance ?? 0))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      {/* Stats Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Today's Orders"
          value={stats?.totalOrders ?? 0}
          subtext="Total processed"
          icon={ShoppingCart}
          variant="default"
        />
        <StatCard
          label="Pending"
          value={pendingCount}
          subtext={formatCurrency(pendingValue)}
          icon={Clock}
          variant="warning"
        />
        <StatCard
          label="Revenue"
          value={formatCurrency(revenue)}
          subtext="Today"
          icon={TrendingUp}
          variant="success"
        />
        <StatCard
          label="Payments to Review"
          value={reviewCount}
          subtext="Unverified"
          icon={MessageSquareWarning}
          variant="danger"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Live Order Feed */}
        <div className="lg:col-span-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <Package className="h-4 w-4" /> Live Orders
          </h3>
          {pendingLoading && (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)]" />
              ))}
            </div>
          )}
          {!pendingLoading && (!pendingOrders || pendingOrders.length === 0) && (
            <EmptyState icon={Package} title="No pending orders" description="New orders will appear here in real time." />
          )}
          {!pendingLoading && pendingOrders && pendingOrders.length > 0 && (
            <div className="space-y-2">
              {pendingOrders.slice(0, 10).map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-semibold text-[var(--color-primary-light)]">
                      {order.referenceNumber}
                    </span>
                    <span className="text-sm text-[var(--color-text-primary)]">
                      {order.customer.name ?? order.customer.waNumber}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-[var(--color-text-secondary)]">
                      {formatCurrency(order.totalAmount)}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">{timeAgo(order.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Outstanding Balances */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <Users className="h-4 w-4" /> Outstanding Balances
          </h3>
          {topDebtors.length === 0 && (
            <EmptyState icon={Users} title="All caught up" description="No customers owe money right now." />
          )}
          {topDebtors.length > 0 && (
            <div className="space-y-2">
              {topDebtors.map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2"
                >
                  <span className="text-sm text-[var(--color-text-primary)]">
                    {customer.name ?? customer.waNumber}
                  </span>
                  <span className="font-mono text-sm font-semibold text-[var(--color-danger)]">
                    {formatCurrency(customer.outstandingBalance)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Alerts Row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Messages Requiring Review */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <MessageSquare className="h-4 w-4" /> Messages to Review
          </h3>
          {(!reviewMessages || reviewMessages.length === 0) && (
            <EmptyState icon={MessageSquare} title="No flagged messages" description="Messages requiring review will appear here." />
          )}
          {reviewMessages && reviewMessages.length > 0 && (
            <div className="space-y-2">
              {reviewMessages.slice(0, 5).map((msg) => (
                <div key={msg.id} className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2">
                  <div>
                    <span className="text-sm text-[var(--color-text-primary)]">{msg.customer?.name ?? msg.customer?.waNumber ?? 'Unknown'}</span>
                    <p className="text-xs text-[var(--color-text-muted)]">{msg.body ?? '(no text)'}</p>
                  </div>
                  <span className="rounded-[var(--radius-sm)] bg-[var(--color-warning-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-warning)]">{msg.intent}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stock Alerts */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <AlertTriangle className="h-4 w-4" /> Low Stock Alerts
          </h3>
          {(!lowStockProducts || lowStockProducts.length === 0) && (
            <EmptyState icon={Package} title="Stock levels healthy" description="All products are above their reorder thresholds." />
          )}
          {lowStockProducts && lowStockProducts.length > 0 && (
            <div className="space-y-2">
              {lowStockProducts.slice(0, 5).map((product) => (
                <div key={product.id} className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2">
                  <span className="text-sm text-[var(--color-text-primary)]">{product.name}</span>
                  <span className="font-mono text-sm text-[var(--color-warning)]">
                    {product.stockQuantity} / {product.reorderThreshold}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
