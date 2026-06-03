import { useParams } from 'react-router-dom';
import { ArrowLeft, Phone, ShoppingCart, CreditCard, Tag, Edit2, Save } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCustomerDetail, useUpdateCustomer } from '@/hooks/useCustomers';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency, timeAgo } from '@/lib/utils';

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
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />
        <div className="h-64 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />
      </div>
    );
  }

  if (!data) {
    return <EmptyState icon={Phone} title="Customer not found" description="The customer you're looking for doesn't exist." />;
  }

  const customer = data;

  const handleSave = () => {
    updateCustomer.mutate(
      {
        id: customer.id,
        data: {
          name: name || customer.name || null,
          notes: notes || customer.notes || null,
          tags: tagsInput ? tagsInput.split(',').map((t) => t.trim()) : customer.tags,
        },
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={() => navigate('/customers')} className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
        <ArrowLeft className="h-4 w-4" /> Back to customers
      </button>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">{customer.name ?? 'Unknown'}</h1>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{customer.waNumber}</p>
          </div>
          <button
            onClick={() => {
              if (editing) handleSave();
              else {
                setName(customer.name ?? '');
                setNotes(customer.notes ?? '');
                setTagsInput(customer.tags.join(', '));
                setEditing(true);
              }
            }}
            className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {editing ? <><Save className="h-4 w-4" /> Save</> : <><Edit2 className="h-4 w-4" /> Edit</>}
          </button>
        </div>

        {editing ? (
          <div className="mt-4 space-y-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Tags (comma separated)" className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" rows={3} />
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {customer.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs text-[var(--color-text-muted)]">
                <Tag className="h-3 w-3" /> {t}
              </span>
            ))}
            {customer.notes && <p className="w-full text-sm text-[var(--color-text-muted)]">{customer.notes}</p>}
          </div>
        )}

        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">Total Orders</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{customer.totalOrders}</p>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">Total Spend</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{formatCurrency(customer.totalSpend)}</p>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">Outstanding</p>
            <p className={`mt-1 text-lg font-semibold ${(customer.outstandingBalance ?? 0) > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
              {formatCurrency(customer.outstandingBalance)}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
            <ShoppingCart className="h-4 w-4" /> Order History
          </h3>
          {data.orders.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">No orders yet.</p>}
          <div className="space-y-2">
            {data.orders.map((order) => (
              <div key={order.id} className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2">
                <div>
                  <span className="font-mono text-xs font-semibold text-[var(--color-primary-light)]">{order.referenceNumber}</span>
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">{order.status}</span>
                </div>
                <span className="font-mono text-sm text-[var(--color-text-secondary)]">{formatCurrency(order.totalAmount)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
            <CreditCard className="h-4 w-4" /> Payment History
          </h3>
          {data.payments.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">No payments yet.</p>}
          <div className="space-y-2">
            {data.payments.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-3 py-2">
                <div>
                  <span className="text-sm text-[var(--color-text-primary)]">{formatCurrency(payment.amount)}</span>
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">{payment.method}</span>
                  {payment.verified && <span className="ml-2 text-[10px] text-[var(--color-success)]">Verified</span>}
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">{timeAgo(payment.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
