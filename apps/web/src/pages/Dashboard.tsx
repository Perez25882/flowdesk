import { useNavigate } from 'react-router-dom';
import { AlertTriangle, MessageSquare, Package, Users } from 'lucide-react';
import { useOrdersByStatus, useOrderStats } from '@/hooks/useOrders';
import { useCustomers } from '@/hooks/useCustomers';
import { usePayments, useRevenueStats } from '@/hooks/usePayments';
import { useMessages } from '@/hooks/useMessages';
import { useLowStockProducts } from '@/hooks/useProducts';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';
import PageHeader from '@/components/shared/PageHeader';
import { Metric, MetricStrip } from '@/components/shared/MetricStrip';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency, timeAgo, customerLabel } from '@/lib/utils';

/**
 * The morning screen.
 *
 * The previous version laid this out as four identical metric cards, then a
 * 2+1 grid, then a 1+1 grid — nine bordered boxes of equal visual weight. The
 * effect was that nothing on the page claimed to matter more than anything
 * else, which is the opposite of what this screen is for.
 *
 * The order here is the order of a shop owner's attention at 6am:
 *
 *   1. The figures. What did last night earn, and what is still open.
 *   2. Orders waiting. The one list that is actually work, given the width.
 *   3. Money owed. The one list that is actually risk.
 *   4. Exceptions — flagged messages, low stock — below the fold, because
 *      they are usually empty and an empty panel should not occupy prime
 *      space every single day.
 */
export default function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();

  const { data: pendingOrders, isLoading: pendingLoading } = useOrdersByStatus('PENDING');
  const { data: stats } = useOrderStats('today');
  const { data: customers } = useCustomers(undefined, undefined, true);
  const { data: unconfirmedPayments } = usePayments(false);
  const { data: revenueStats } = useRevenueStats();
  const { data: reviewMessages } = useMessages(true);
  const { data: lowStockProducts } = useLowStockProducts();

  useRealtimeOrders();

  const pendingCount = stats?.byStatus?.PENDING ?? pendingOrders?.length ?? 0;
  const pendingValue = pendingOrders?.reduce((sum, o) => sum + (o.totalAmount ?? 0), 0) ?? 0;
  // Money actually received today, from attested payments — NOT the sum of
  // today's order values, which is what `stats.totalRevenue` returns. That
  // figure counts orders that are still pending and orders that were cancelled,
  // so it reads high and it reads high in the owner's favour. Abena's stated
  // job is "know at end of day how much came in"; showing her what was ordered
  // and calling it revenue answers a different question badly.
  const revenue = revenueStats?.today ?? 0;

  // Kept, but labelled for what it is.
  const orderedValue = stats?.totalRevenue ?? 0;
  const reviewCount = unconfirmedPayments?.length ?? 0;

  const topDebtors = [...(customers ?? [])]
    .filter((c) => (c.outstandingBalance ?? 0) > 0)
    .sort((a, b) => (b.outstandingBalance ?? 0) - (a.outstandingBalance ?? 0))
    .slice(0, 6);

  const owedTotal = topDebtors.reduce((sum, c) => sum + (c.outstandingBalance ?? 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Today"
        description="Overnight, and what is still open."
        actions={
          <Button variant="secondary" size="sm" onClick={() => navigate('/orders')}>
            Open the board
          </Button>
        }
      />

      {/* Revenue leads. It is the number the owner opened the app for, so it
          gets the wider column and the larger figure. */}
      <MetricStrip>
        <Metric
          label="Money in today"
          value={formatCurrency(revenue)}
          detail={
            orderedValue > revenue
              ? `${formatCurrency(orderedValue)} ordered`
              : stats?.totalOrders
                ? `across ${stats.totalOrders} orders`
                : 'no orders yet'
          }
          emphasis
        />
        <Metric
          label="Awaiting confirmation"
          value={pendingCount}
          detail={pendingCount > 0 ? `worth ${formatCurrency(pendingValue)}` : 'nothing waiting'}
          tone={pendingCount > 0 ? 'warning' : 'default'}
        />
        <Metric
          label="Payments to verify"
          value={reviewCount}
          detail={reviewCount > 0 ? 'waiting on you' : 'all confirmed'}
          tone={reviewCount > 0 ? 'danger' : 'default'}
        />
        <Metric
          label="Money owed to you"
          value={formatCurrency(owedTotal)}
          detail={
            topDebtors.length > 0
              ? `${topDebtors.length} customer${topDebtors.length === 1 ? '' : 's'}`
              : 'nobody owes you'
          }
          tone={owedTotal > 0 ? 'warning' : 'default'}
        />
      </MetricStrip>

      {/* Two columns, deliberately unequal. The order queue is work in
          progress and needs room for a reference, a name and a figure; the
          debtor list is three short fields. Giving them equal width would
          leave one cramped and the other padded. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Panel>
          <PanelHead
            title="Waiting on you"
            meta={pendingCount > 0 ? `${pendingCount} order${pendingCount === 1 ? '' : 's'}` : undefined}
            action={
              <Button variant="link" className="text-sm" onClick={() => navigate('/orders')}>
                All orders
              </Button>
            }
          />

          {pendingLoading ? (
            <SkeletonRows count={5} />
          ) : !pendingOrders || pendingOrders.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Nothing waiting"
              description="Every order is confirmed."
            />
          ) : (
            <RowList>
              {pendingOrders.slice(0, 8).map((order) => (
                <Row key={order.id} onClick={() => navigate('/orders')}>
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span className="fd-figure shrink-0 text-xs font-semibold text-primary">
                      {order.referenceNumber}
                    </span>
                    <span className="truncate text-sm text-text-primary">
                      {customerLabel(order.customer)}
                    </span>
                  </span>

                  <span className="flex shrink-0 items-baseline gap-4">
                    <span className="text-xs text-text-muted">{timeAgo(order.createdAt)}</span>
                    <span className="fd-figure text-sm font-semibold text-text-primary">
                      {formatCurrency(order.totalAmount)}
                    </span>
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="Owed to you"
            meta={owedTotal > 0 ? formatCurrency(owedTotal) : undefined}
            action={
              <Button variant="link" className="text-sm" onClick={() => navigate('/customers')}>
                Customers
              </Button>
            }
          />

          {topDebtors.length === 0 ? (
            <EmptyState
              icon={Users}
              title="All settled"
              description="Nobody owes you."
            />
          ) : (
            <RowList>
              {topDebtors.map((customer) => (
                <Row key={customer.id} onClick={() => navigate(`/customers/${customer.id}`)}>
                  <span className="truncate text-sm text-text-primary">
                    {customerLabel(customer)}
                  </span>
                  <span className="fd-figure shrink-0 text-sm font-semibold text-danger">
                    {formatCurrency(customer.outstandingBalance)}
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </Panel>
      </div>

      {/* Exceptions. Both of these are empty on a good day, which is why they
          sit here rather than above: a dashboard whose top half is usually two
          "all clear" panels has taught the owner to ignore its top half. */}
      <div className="grid gap-5 md:grid-cols-2">
        <Panel>
          <PanelHead
            title="Needs your eyes"
            meta={reviewMessages?.length ? `${reviewMessages.length}` : undefined}
            action={
              reviewMessages && reviewMessages.length > 0 ? (
                <Button variant="link" className="text-sm" onClick={() => navigate('/messages')}>
                  Review
                </Button>
              ) : undefined
            }
          />

          {!reviewMessages || reviewMessages.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="All clear"
              description="Flowdesk understood everything."
            />
          ) : (
            <RowList>
              {reviewMessages.slice(0, 5).map((msg) => (
                <Row key={msg.id} onClick={() => navigate('/messages')} className="items-start">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {customerLabel(msg.customer)}
                    </span>
                    <span className="line-clamp-1 text-xs text-text-secondary">
                      {msg.body ?? 'No text in this message'}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-sm border border-warning-border bg-warning-muted px-1.5 py-[3px] text-2xs font-semibold uppercase tracking-wide text-warning">
                    {msg.intent}
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="Running low"
            meta={lowStockProducts?.length ? `${lowStockProducts.length}` : undefined}
            action={
              lowStockProducts && lowStockProducts.length > 0 ? (
                <Button variant="link" className="text-sm" onClick={() => navigate('/products')}>
                  Products
                </Button>
              ) : undefined
            }
          />

          {!lowStockProducts || lowStockProducts.length === 0 ? (
            <EmptyState
              icon={AlertTriangle}
              title="Stock is healthy"
              description="Everything is above its reorder level."
            />
          ) : (
            <RowList>
              {lowStockProducts.slice(0, 5).map((product) => (
                <Row key={product.id} onClick={() => navigate('/products')}>
                  <span className="truncate text-sm text-text-primary">{product.name}</span>
                  <span className="fd-figure shrink-0 text-sm text-text-secondary">
                    <span className="font-semibold text-warning">{product.stockQuantity}</span>
                    <span className="text-text-muted"> / {product.reorderThreshold}</span>
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </Panel>
      </div>
    </div>
  );
}
