import {
  Package,
  CreditCard,
  Clock,
  CheckCircle2,
  AlertTriangle,
  User,
  Send,
} from 'lucide-react';
import { useState } from 'react';
import type { OrderStatus } from '@/types/order';
import { useOrderDetail, useUpdateOrderStatus, useAssignOrder } from '@/hooks/useOrders';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetBody } from '@/components/ui/Sheet';
import { formatCurrency, timeAgo } from '@/lib/utils';

interface OrderDetailDrawerProps {
  orderId: string | null;
  onClose: () => void;
}

const actionMap: Record<OrderStatus, { label: string; next: OrderStatus; variant: string }[]> = {
  PENDING: [{ label: 'Confirm Order', next: 'CONFIRMED', variant: 'primary' }],
  CONFIRMED: [{ label: 'Mark Processing', next: 'PROCESSING', variant: 'primary' }],
  PROCESSING: [{ label: 'Mark Fulfilled', next: 'FULFILLED', variant: 'primary' }],
  FULFILLED: [],
  CANCELLED: [],
};

const paymentStatus = (total: number, paid: number): { label: string; color: string } => {
  if (paid >= total) return { label: 'Paid', color: 'text-[var(--color-success)]' };
  if (paid > 0) return { label: 'Partial', color: 'text-[var(--color-warning)]' };
  return { label: 'Unpaid', color: 'text-[var(--color-danger)]' };
};

export default function OrderDetailDrawer({ orderId, onClose }: OrderDetailDrawerProps): React.JSX.Element {
  const { data: order, isLoading } = useOrderDetail(orderId);
  const updateStatus = useUpdateOrderStatus();
  const assignOrder = useAssignOrder();
  const [assignStaffId, setAssignStaffId] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('MOMO_MTN');
  const [paymentRef, setPaymentRef] = useState('');

  const actions = order ? actionMap[order.status] : [];
  const pmt = order ? paymentStatus(order.totalAmount, order.amountPaid) : { label: '', color: '' };

  const handleStatusChange = (nextStatus: OrderStatus): void => {
    if (!order) return;
    updateStatus.mutate({ orderId: order.id, data: { status: nextStatus } });
  };

  const handleAssign = (): void => {
    if (!order || !assignStaffId) return;
    assignOrder.mutate({ orderId: order.id, data: { staffId: assignStaffId } });
  };

  const customerPhone = order?.customer.waNumber ?? '';
  const whatsappLink = customerPhone ? `https://wa.me/${customerPhone}` : '#';

  return (
    <Sheet open={!!orderId} onOpenChange={(open) => !open && onClose()}>
      <SheetTrigger asChild>
        <span className="hidden" />
      </SheetTrigger>
      <SheetContent side="right" className="!w-[400px] !p-0 md:!w-[480px]">
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
          </div>
        )}

        {!isLoading && !order && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Order not found
          </div>
        )}

        {!isLoading && order && (
          <div className="flex h-full flex-col">
            <SheetHeader className="shrink-0">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-1">
                  <SheetTitle className="font-mono text-[var(--color-primary-light)]">
                    {order.referenceNumber}
                  </SheetTitle>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {timeAgo(order.createdAt)}
                  </span>
                </div>
                <span className="inline-flex rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs font-semibold uppercase text-[var(--color-text-secondary)]">
                  {order.status}
                </span>
              </div>
            </SheetHeader>

            <SheetBody className="flex-1 space-y-5 overflow-y-auto">
              {/* Customer */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Customer
                </h4>
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-3">
                  <p className="font-medium text-[var(--color-text-primary)]">
                    {order.customer.name ?? 'Unknown'}
                  </p>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    {order.customer.waNumber}
                  </p>
                  {order.customer.totalOrders !== undefined && (
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {order.customer.totalOrders} orders
                    </p>
                  )}
                  {(order.customer.outstandingBalance ?? 0) > 0 && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--color-danger)]">
                      <AlertTriangle className="h-3 w-3" />
                      Owes {formatCurrency(order.customer.outstandingBalance ?? 0)}
                    </p>
                  )}
                </div>
              </div>

              {/* Items */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Items
                </h4>
                <div className="space-y-1">
                  {order.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Package className={`h-4 w-4 ${item.matched ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}`} />
                        <span className="text-sm text-[var(--color-text-primary)]">
                          {item.description}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm text-[var(--color-text-secondary)]">
                          × {item.quantity}
                        </span>
                        <p className="font-mono text-xs text-[var(--color-text-muted)]">
                          {formatCurrency(item.unitPrice)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">Total</span>
                  <span className="font-mono text-lg font-semibold text-[var(--color-text-primary)]">
                    {formatCurrency(order.totalAmount)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--color-text-secondary)]">Paid</span>
                  <span className="font-mono text-sm text-[var(--color-success)]">
                    {formatCurrency(order.amountPaid)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--color-text-secondary)]">Balance</span>
                  <span className="font-mono text-sm text-[var(--color-danger)]">
                    {formatCurrency(order.totalAmount - order.amountPaid)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CreditCard className="h-4 w-4 text-[var(--color-text-muted)]" />
                  <span className={`text-xs font-medium ${pmt.color}`}>{pmt.label}</span>
                </div>
              </div>

              {/* Timeline */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Status History
                </h4>
                <div className="space-y-2">
                  {order.statusHistory.map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2 text-sm">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
                      <div>
                        <span className="text-[var(--color-text-primary)]">
                          {entry.fromStatus ? `${entry.fromStatus} → ` : ''}
                          {entry.toStatus}
                        </span>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {entry.changedBy ?? 'System'} · {timeAgo(entry.createdAt)}
                        </p>
                        {entry.note && (
                          <p className="text-xs text-[var(--color-text-secondary)]">{entry.note}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Staff Assignment */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Assigned To
                </h4>
                <div className="flex items-center gap-2">
                  {order.assignedTo ? (
                    <>
                      <User className="h-4 w-4 text-[var(--color-primary-light)]" />
                      <span className="text-sm text-[var(--color-text-primary)]">{order.assignedTo.name}</span>
                    </>
                  ) : (
                    <span className="text-sm text-[var(--color-text-muted)]">Unassigned</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={assignStaffId}
                    onChange={(e) => setAssignStaffId(e.target.value)}
                    placeholder="Staff ID"
                    className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <button
                    onClick={handleAssign}
                    className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-light)]"
                  >
                    Assign
                  </button>
                </div>
              </div>

              {/* Log Payment */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Log Payment
                </h4>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder="Amount"
                    className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                  >
                    <option value="MOMO_MTN">MTN MoMo</option>
                    <option value="MOMO_VODAFONE">Vodafone Cash</option>
                    <option value="MOMO_AIRTELTIGO">AirtelTigo</option>
                    <option value="CASH">Cash</option>
                    <option value="BANK_TRANSFER">Bank</option>
                  </select>
                </div>
                <input
                  type="text"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="Reference number"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                />
                <button
                  onClick={() => {
                    // Payment logging mutation will be wired when payment module is built
                  }}
                  className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
                >
                  Log Payment
                </button>
              </div>

              {/* Actions */}
              {actions && actions.length > 0 && (
                <div className="space-y-2">
                  {actions.map((action) => (
                    <button
                      key={action.next}
                      onClick={() => handleStatusChange(action.next)}
                      className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)]"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {action.label}
                    </button>
                  ))}
                  {order.status !== 'CANCELLED' && order.status !== 'FULFILLED' && (
                    <button
                      onClick={() => handleStatusChange('CANCELLED')}
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-danger)] px-4 py-2.5 text-sm font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-muted)]"
                    >
                      Cancel Order
                    </button>
                  )}
                </div>
              )}

              {/* WhatsApp */}
              <a
                href={whatsappLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-success-muted)] px-4 py-2.5 text-sm font-medium text-[var(--color-success)] transition-colors hover:bg-[rgba(34,197,94,0.2)]"
              >
                <Send className="h-4 w-4" />
                Message on WhatsApp
              </a>
            </SheetBody>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
