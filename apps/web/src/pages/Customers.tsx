import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Users, Tag, AlertTriangle } from 'lucide-react';
import { useCustomers } from '@/hooks/useCustomers';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency } from '@/lib/utils';

export default function CustomersPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const { data: customers, isLoading } = useCustomers(search || undefined, tag || undefined);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Customers</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone..."
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Filter by tag"
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-2 px-3 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
          />
        </div>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)]" />
          ))}
        </div>
      )}

      {!isLoading && (!customers || customers.length === 0) && (
        <EmptyState icon={Users} title="No customers yet" description="Customers appear automatically when they message your business on WhatsApp." />
      )}

      {!isLoading && customers && customers.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="grid grid-cols-12 gap-4 border-b border-[var(--color-border)] px-4 py-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            <div className="col-span-3">Name</div>
            <div className="col-span-2">Phone</div>
            <div className="col-span-1 text-right">Orders</div>
            <div className="col-span-2 text-right">Total Spend</div>
            <div className="col-span-2 text-right">Balance</div>
            <div className="col-span-2">Tags</div>
          </div>
          {customers.map((customer) => (
            <button
              key={customer.id}
              onClick={() => navigate(`/customers/${customer.id}`)}
              className="grid w-full grid-cols-12 gap-4 border-b border-[var(--color-border)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <div className="col-span-3 flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {customer.name ?? 'Unknown'}
                </span>
                {customer.vip && (
                  <span className="rounded-[var(--radius-sm)] bg-[var(--color-warning-muted)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--color-warning)]">
                    VIP
                  </span>
                )}
                {customer.blacklisted && (
                  <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-danger)]" />
                )}
              </div>
              <div className="col-span-2 text-sm text-[var(--color-text-secondary)]">{customer.waNumber}</div>
              <div className="col-span-1 text-right text-sm text-[var(--color-text-secondary)]">{customer.totalOrders}</div>
              <div className="col-span-2 text-right font-mono text-sm text-[var(--color-text-secondary)]">
                {formatCurrency(customer.totalSpend)}
              </div>
              <div className={`col-span-2 text-right font-mono text-sm ${(customer.outstandingBalance ?? 0) > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
                {formatCurrency(customer.outstandingBalance)}
              </div>
              <div className="col-span-2 flex flex-wrap gap-1">
                {customer.tags.slice(0, 3).map((t) => (
                  <span key={t} className="inline-flex items-center gap-0.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                    <Tag className="h-2.5 w-2.5" /> {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
