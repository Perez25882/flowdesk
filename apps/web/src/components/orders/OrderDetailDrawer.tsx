import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { OrderStatus } from '@/types/order';
import { useOrderDetail, useUpdateOrderStatus, useAssignOrder } from '@/hooks/useOrders';
import { useCreatePayment } from '@/hooks/usePayments';
import { useStaff } from '@/hooks/useStaff';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
  SheetFooter,
} from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/Dialog';
import { TextAreaField } from '@/components/ui/Field';
import { OrderStatusBadge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatCurrency, timeAgo, cn } from '@/lib/utils';

interface OrderDetailDrawerProps {
  orderId: string | null;
  onClose: () => void;
}

/**
 * The order record.
 *
 * The single most consequential change here is that the primary action —
 * "Confirm order", the reason the drawer was opened at all — used to sit at
 * the very bottom, below the items, the status history, the staff picker and
 * the payment form. On a phone that is four screens of scrolling to press one
 * button. It now lives in a footer pinned to the bottom of the sheet.
 *
 * Everything else follows one rule: what is true about the order comes first
 * (customer, items, money), what you can do to it comes last.
 */

const NEXT_ACTION: Record<OrderStatus, { label: string; next: OrderStatus } | null> = {
  PENDING: { label: 'Confirm order', next: 'CONFIRMED' },
  CONFIRMED: { label: 'Start packing', next: 'PROCESSING' },
  PROCESSING: { label: 'Mark delivered', next: 'FULFILLED' },
  FULFILLED: null,
  CANCELLED: null,
};

const PAYMENT_METHODS = [
  { value: 'MOMO_MTN', label: 'MTN MoMo' },
  { value: 'MOMO_VODAFONE', label: 'Telecel Cash' },
  { value: 'MOMO_AIRTELTIGO', label: 'AirtelTigo Money' },
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'OTHER', label: 'Other' },
];

/** A labelled section separated by a rule, not a nested bordered card. */
function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="border-t border-border-subtle py-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="fd-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label on the left, figure on the right, both on one baseline. */
function Line({
  label,
  value,
  tone = 'default',
  strong = false,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'danger';
  strong?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={cn('text-sm', strong ? 'font-medium text-text-primary' : 'text-text-secondary')}>
        {label}
      </span>
      <span
        className={cn(
          'fd-figure',
          strong ? 'text-lg font-semibold' : 'text-sm',
          tone === 'success' && 'text-success',
          tone === 'danger' && 'text-danger',
          tone === 'default' && 'text-text-primary',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export default function OrderDetailDrawer({
  orderId,
  onClose,
}: OrderDetailDrawerProps): React.JSX.Element {
  const { data: order, isLoading } = useOrderDetail(orderId);
  const updateStatus = useUpdateOrderStatus();
  const assignOrder = useAssignOrder();
  const createPayment = useCreatePayment();
  const { data: staffList = [] } = useStaff();

  const [assignStaffId, setAssignStaffId] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('MOMO_MTN');
  const [paymentRef, setPaymentRef] = useState('');

  const action = order ? NEXT_ACTION[order.status] : null;
  const remaining = order ? Math.max(0, order.totalAmount - order.amountPaid) : 0;
  const isSettled = order ? order.amountPaid >= order.totalAmount : false;
  const isOpen = order ? order.status !== 'CANCELLED' && order.status !== 'FULFILLED' : false;

  const customerPhone = order?.customer.waNumber ?? '';
  const whatsappLink = customerPhone
    ? `https://wa.me/${customerPhone.replace(/[^\d]/g, '')}`
    : undefined;

  function handleStatusChange(nextStatus: OrderStatus): void {
    if (!order) return;
    updateStatus.mutate({ orderId: order.id, data: { status: nextStatus } });
  }

  /**
   * Cancelling asks for a reason first.
   *
   * The API requires one — it ends up on the order, in the status history, and
   * in the message the customer receives, so "cancelled, no reason given" is not
   * something the server will accept. The button used to send the status with no
   * note at all, which came back 400 and was never rendered anywhere: the
   * spinner stopped, the optimistic update rolled back, and nothing happened.
   * There was no working way to cancel an order anywhere in the product.
   */
  function handleConfirmCancel(): void {
    if (!order) return;

    const reason = cancelReason.trim();
    if (reason.length === 0) {
      setCancelError('Please give a reason — the customer is told why.');
      return;
    }

    updateStatus.mutate(
      { orderId: order.id, data: { status: 'CANCELLED', note: reason } },
      {
        onSuccess: () => {
          setCancelOpen(false);
          setCancelReason('');
          setCancelError(null);
        },
        onError: (error: Error) => setCancelError(error.message),
      },
    );
  }

  function handleAssign(): void {
    if (!order || !assignStaffId) return;
    assignOrder.mutate(
      { orderId: order.id, data: { staffId: assignStaffId } },
      { onSuccess: () => setAssignStaffId('') },
    );
  }

  function handleLogPayment(): void {
    if (!order) return;
    const amount = Number.parseFloat(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    createPayment.mutate(
      {
        customerId: order.customer.id,
        orderId: order.id,
        amount,
        method: paymentMethod,
        ...(paymentRef ? { reference: paymentRef } : {}),
      },
      {
        onSuccess: () => {
          setPaymentAmount('');
          setPaymentRef('');
        },
      },
    );
  }

  return (
    <Sheet open={!!orderId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right">
        {isLoading && (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">Loading order</SheetTitle>
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-1.5 h-3 w-20" />
            </SheetHeader>
            <SheetBody className="space-y-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </SheetBody>
          </>
        )}

        {!isLoading && !order && (
          <>
            <SheetHeader>
              <SheetTitle>Order not found</SheetTitle>
            </SheetHeader>
            <SheetBody>
              <p className="text-sm text-text-secondary">
                This order may have been deleted, or it belongs to a different business.
              </p>
            </SheetBody>
          </>
        )}

        {!isLoading && order && (
          <>
            <SheetHeader>
              <div className="flex items-center justify-between gap-3">
                <SheetTitle className="fd-figure text-base text-primary">
                  {order.referenceNumber}
                </SheetTitle>
                <OrderStatusBadge status={order.status} />
              </div>
              <p className="text-xs text-text-muted">Opened {timeAgo(order.createdAt)}</p>
            </SheetHeader>

            <SheetBody className="py-0">
              <Section
                title="Customer"
                action={
                  whatsappLink ? (
                    <a
                      href={whatsappLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
                    >
                      Open chat
                      <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    </a>
                  ) : undefined
                }
              >
                <p className="text-base font-semibold text-text-primary">
                  {order.customer.name ?? 'Unknown customer'}
                </p>
                <p className="fd-figure text-sm text-text-secondary">{order.customer.waNumber}</p>

                {order.customer.totalOrders !== undefined && (
                  <p className="mt-1 text-xs text-text-muted">
                    {order.customer.totalOrders} order
                    {order.customer.totalOrders === 1 ? '' : 's'} in total
                  </p>
                )}

                {(order.customer.outstandingBalance ?? 0) > 0 && (
                  <p className="mt-2.5 flex items-center gap-1.5 rounded-sm bg-danger-muted px-2 py-1.5 text-xs font-medium text-danger">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                    Owes {formatCurrency(order.customer.outstandingBalance ?? 0)} across all orders
                  </p>
                )}
              </Section>

              <Section title="Items">
                <ul className="divide-y divide-border-subtle">
                  {order.items.map((item) => (
                    <li key={item.id} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="flex min-w-0 items-baseline gap-2">
                        {/* An unmatched line is one Flowdesk could not tie to a
                            catalogue product, so its price is a guess. Worth
                            saying in words. */}
                        {!item.matched && (
                          <span
                            className="shrink-0 rounded-xs bg-warning-muted px-1 py-px text-[10px] font-semibold uppercase text-warning"
                            title="Not matched to a product in your catalogue"
                          >
                            Check
                          </span>
                        )}
                        <span className="truncate text-sm text-text-primary">
                          {item.description}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-3">
                        <span className="fd-figure text-xs text-text-muted">×{item.quantity}</span>
                        <span className="fd-figure w-[76px] text-right text-sm text-text-secondary">
                          {formatCurrency(item.unitPrice)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 border-t border-border pt-2">
                  <Line label="Total" value={formatCurrency(order.totalAmount)} strong />
                  <Line
                    label="Paid"
                    value={formatCurrency(order.amountPaid)}
                    tone={order.amountPaid > 0 ? 'success' : 'default'}
                  />
                  <Line
                    label={isSettled ? 'Settled' : 'Still owed'}
                    value={formatCurrency(remaining)}
                    tone={remaining > 0 ? 'danger' : 'success'}
                  />
                </div>
              </Section>

              <Section title="Assigned to">
                <p className="mb-2.5 text-sm text-text-primary">
                  {order.assignedTo ? order.assignedTo.name : 'Nobody yet'}
                </p>

                <div className="flex gap-2">
                  <select
                    aria-label="Assign this order to a staff member"
                    value={assignStaffId}
                    onChange={(e) => setAssignStaffId(e.target.value)}
                    className="fd-input fd-select fd-input-compact h-11 flex-1 py-0 sm:h-10"
                  >
                    <option value="">Choose someone</option>
                    {staffList
                      .filter((s) => s.active)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} — {s.role.toLowerCase().replace('_', ' ')}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-10"
                    onClick={handleAssign}
                    disabled={!assignStaffId}
                    isLoading={assignOrder.isPending}
                  >
                    Assign
                  </Button>
                </div>
              </Section>

              {remaining > 0 && (
                <Section title="Record a payment">
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0.01}
                        step={0.01}
                        max={remaining}
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        aria-label={`Amount received, up to ${formatCurrency(remaining)}`}
                        placeholder={formatCurrency(remaining)}
                        className="fd-input fd-input-compact h-11 w-full py-0 sm:h-10 sm:flex-1"
                      />
                      <select
                        aria-label="How they paid"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="fd-input fd-select fd-input-compact h-11 w-full py-0 sm:h-10 sm:w-[150px]"
                      >
                        {PAYMENT_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>
                            {method.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <input
                      type="text"
                      value={paymentRef}
                      onChange={(e) => setPaymentRef(e.target.value)}
                      aria-label="Transaction reference"
                      placeholder="Transaction ID, if you have one"
                      className="fd-input fd-input-compact h-11 py-0 sm:h-10"
                    />

                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-10"
                      onClick={handleLogPayment}
                      disabled={!paymentAmount || (Number.parseFloat(paymentAmount) || 0) <= 0}
                      isLoading={createPayment.isPending}
                    >
                      Record {paymentAmount ? formatCurrency(Number.parseFloat(paymentAmount) || 0) : 'payment'}
                    </Button>

                    {createPayment.isError && (
                      <p role="alert" className="text-xs font-medium text-danger">
                        {(createPayment.error as Error).message}
                      </p>
                    )}
                  </div>
                </Section>
              )}

              <Section title="History">
                <ol className="relative space-y-3 border-l border-border-subtle pl-4">
                  {order.statusHistory.map((entry) => (
                    <li key={entry.id} className="relative">
                      <span
                        aria-hidden="true"
                        className="absolute -left-[21px] top-1.5 h-1.5 w-1.5 rounded-full bg-border-strong ring-4 ring-surface"
                      />
                      <p className="text-sm text-text-primary">
                        {entry.fromStatus ? `${entry.fromStatus} → ` : ''}
                        {entry.toStatus}
                      </p>
                      <p className="text-xs text-text-muted">
                        {entry.changedBy ?? 'Flowdesk'} · {timeAgo(entry.createdAt)}
                      </p>
                      {entry.note && (
                        <p className="mt-0.5 text-xs text-text-secondary">{entry.note}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </Section>
            </SheetBody>

            {/* Pinned. The whole point of opening this drawer is usually the
                first button in it. */}
            {(action || isOpen) && (
              <SheetFooter>
                {action && (
                  <Button
                    fullWidth
                    onClick={() => handleStatusChange(action.next)}
                    isLoading={updateStatus.isPending}
                  >
                    {action.label}
                  </Button>
                )}
                {isOpen && (
                  <Button
                    variant="secondary"
                    className={cn('shrink-0 text-danger', !action && 'flex-1')}
                    onClick={() => {
                      setCancelError(null);
                      setCancelOpen(true);
                    }}
                    disabled={updateStatus.isPending}
                  >
                    Cancel
                  </Button>
                )}
              </SheetFooter>
            )}
          </>
        )}
      </SheetContent>

      <Dialog
        open={cancelOpen}
        onOpenChange={(next) => {
          setCancelOpen(next);
          if (!next) setCancelError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {order?.referenceNumber}?</DialogTitle>
            <DialogDescription>
              {order?.customer.name ?? 'The customer'} will be sent a WhatsApp message telling them
              the order is cancelled, and the reason you give here.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <TextAreaField
              label="Reason"
              rows={3}
              value={cancelReason}
              placeholder="Out of stock, customer changed their mind…"
              onChange={(event) => {
                setCancelReason(event.target.value);
                if (cancelError) setCancelError(null);
              }}
              {...(cancelError ? { error: cancelError } : {})}
            />
          </DialogBody>

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setCancelOpen(false)}
              disabled={updateStatus.isPending}
            >
              Keep the order
            </Button>
            <Button
              className="text-danger"
              onClick={handleConfirmCancel}
              isLoading={updateStatus.isPending}
            >
              Cancel the order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
