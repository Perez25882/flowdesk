import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Phone } from 'lucide-react';
import { useCustomerDetail, useUpdateCustomer } from '@/hooks/useCustomers';
import EmptyState from '@/components/shared/EmptyState';
import { Metric, MetricStrip } from '@/components/shared/MetricStrip';
import { Panel, PanelHead, Row, RowList } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Badge, OrderStatusBadge } from '@/components/ui/Badge';
import { formatCurrency, timeAgo } from '@/lib/utils';

const METHOD_LABEL: Record<string, string> = {
  MOMO_MTN: 'MTN MoMo',
  MOMO_VODAFONE: 'Telecel Cash',
  MOMO_AIRTELTIGO: 'AirtelTigo Money',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

/**
 * One customer's record.
 *
 * The edit affordance used to be a button that silently switched between
 * "Edit" and "Save" — pressing it while editing committed the changes with no
 * way to abandon them, and there was no indication anything was in flight.
 * Editing is now an explicit mode with Save and Cancel, and Save reports both
 * its progress and its failures.
 */
export default function CustomerProfilePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useCustomerDetail(id ?? null);
  const updateCustomer = useUpdateCustomer();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <Panel>
        <EmptyState
          icon={Phone}
          variant="page"
          title="Customer not found"
          description="This record may have been removed."
          action={{ label: 'Back to customers', onClick: () => navigate('/customers') }}
        />
      </Panel>
    );
  }

  const customer = data;
  const owes = customer.outstandingBalance ?? 0;
  const whatsappLink = `https://wa.me/${customer.waNumber.replace(/[^\d]/g, '')}`;

  function beginEdit(): void {
    setName(customer.name ?? '');
    setNotes(customer.notes ?? '');
    setTagsInput(customer.tags.join(', '));
    setEditing(true);
  }

  function handleSave(): void {
    updateCustomer.mutate(
      {
        id: customer.id,
        data: {
          name: name.trim() || null,
          notes: notes.trim() || null,
          tags: tagsInput
            ? tagsInput
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
        },
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Every detail view needs a way back. Without it the only exit is the
          browser button, which on an installed PWA does not exist. */}
      <button
        type="button"
        onClick={() => navigate('/customers')}
        className="-ml-1 inline-flex w-fit items-center gap-1.5 rounded-sm px-1 py-0.5 text-sm text-text-secondary transition-colors duration-fast ease-out hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        All customers
      </button>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tighter text-text-primary">
              {customer.name ?? 'Unnamed customer'}
            </h1>
            {customer.vip && <Badge tone="warning">VIP</Badge>}
            {customer.blacklisted && <Badge tone="danger">Blocked</Badge>}
          </div>

          <a
            href={whatsappLink}
            target="_blank"
            rel="noopener noreferrer"
            className="fd-figure mt-1 inline-flex items-center gap-1.5 text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
          >
            {customer.waNumber}
            <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Open this conversation in WhatsApp</span>
          </a>
        </div>

        {!editing && (
          <Button size="sm" variant="secondary" onClick={beginEdit} className="shrink-0">
            Edit details
          </Button>
        )}
      </header>

      <MetricStrip className="md:grid-cols-3">
        <Metric label="Orders" value={customer.totalOrders} />
        <Metric label="Spent with you" value={formatCurrency(customer.totalSpend)} emphasis />
        <Metric
          label={owes > 0 ? 'Still owes' : 'Balance'}
          value={owes > 0 ? formatCurrency(owes) : 'Settled'}
          tone={owes > 0 ? 'danger' : 'success'}
        />
      </MetricStrip>

      {editing ? (
        <Panel>
          <PanelHead title="Edit details" />
          <div className="flex flex-col gap-4 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What do you call them?"
                className="fd-input fd-input-compact h-11 py-0 sm:h-10"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">Tags</span>
              <input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="wholesale, pays late, Kumasi"
                className="fd-input fd-input-compact h-11 py-0 sm:h-10"
              />
              <span className="text-xs text-text-muted">
                Separate with commas.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Anything worth remembering."
                className="fd-input fd-input-compact resize-y"
              />
            </label>

            {updateCustomer.isError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {(updateCustomer.error as Error).message}
              </p>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={handleSave} isLoading={updateCustomer.isPending}>
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        (customer.tags.length > 0 || customer.notes) && (
          <Panel>
            <div className="flex flex-col gap-3 p-4">
              {customer.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {customer.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-sm bg-surface-sunken px-2 py-0.5 text-xs text-text-secondary"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {customer.notes && (
                <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
                  {customer.notes}
                </p>
              )}
            </div>
          </Panel>
        )
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHead
            title="Orders"
            meta={data.orders.length > 0 ? `${data.orders.length}` : undefined}
          />

          {data.orders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="Nothing ordered yet."
            />
          ) : (
            <RowList>
              {data.orders.map((order) => (
                <Row key={order.id} onClick={() => navigate('/orders')}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="fd-figure shrink-0 text-xs text-text-muted">
                      {order.referenceNumber}
                    </span>
                    <OrderStatusBadge status={order.status} />
                  </span>
                  <span className="fd-figure shrink-0 text-sm font-semibold text-text-primary">
                    {formatCurrency(order.totalAmount)}
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="Payments"
            meta={data.payments.length > 0 ? `${data.payments.length}` : undefined}
          />

          {data.payments.length === 0 ? (
            <EmptyState
              title="Nothing paid yet"
              description="Nothing paid yet."
            />
          ) : (
            <RowList>
              {data.payments.map((payment) => (
                <Row key={payment.id}>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="fd-figure text-sm font-semibold text-text-primary">
                      {formatCurrency(payment.amount)}
                    </span>
                    <span className="truncate text-xs text-text-muted">
                      {METHOD_LABEL[payment.method] ?? payment.method} ·{' '}
                      {timeAgo(payment.createdAt)}
                    </span>
                  </span>

                  {payment.verified ? (
                    <Badge tone="success">Verified</Badge>
                  ) : (
                    <Badge tone="warning">Unverified</Badge>
                  )}
                </Row>
              ))}
            </RowList>
          )}
        </Panel>
      </div>
    </div>
  );
}
