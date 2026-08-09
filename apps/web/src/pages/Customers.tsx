import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Users } from 'lucide-react';
import { useCustomers } from '@/hooks/useCustomers';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import SearchInput from '@/components/ui/SearchInput';
import { Panel, Row, RowList } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { formatCurrency, cn } from '@/lib/utils';

/**
 * The customer ledger.
 *
 * A real `<table>` on desktop, because this is tabular data and a screen
 * reader should be able to say "Balance, GHS 240.00" rather than reading a
 * naked number out of a grid of divs. The previous version used a 12-column
 * div grid with headings that were not associated with any cell.
 *
 * On a phone the same records become rows, since a six-column table at 360px
 * is either unreadable or requires horizontal scrolling.
 */
export default function CustomersPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const { data: customers, isLoading } = useCustomers(search || undefined, tag || undefined);

  const isEmpty = !isLoading && (!customers || customers.length === 0);
  const isFiltered = search.length > 0 || tag.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customers"
        description="Who buys, and who owes."
        actions={
          <>
            <SearchInput
              label="Search customers by name or number"
              placeholder="Name or number"
              value={search}
              onChange={setSearch}
              className="w-full sm:w-56"
            />
            <input
              type="text"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Filter customers by tag"
              placeholder="Tag"
              className="fd-input fd-input-compact h-10 w-full py-0 sm:h-9 sm:w-28"
            />
          </>
        }
      />

      <Panel>
        {isLoading && <SkeletonRows count={6} />}

        {isEmpty && (
          <EmptyState
            icon={Users}
            title={isFiltered ? 'No matches' : 'No customers yet'}
            description={
              isFiltered
                ? 'Try part of a name, or the last digits of a number.'
                : 'Customers appear the first time someone messages you.'
            }
            {...(isFiltered
              ? {
                  action: {
                    label: 'Clear filters',
                    onClick: () => {
                      setSearch('');
                      setTag('');
                    },
                  },
                }
              : {})}
          />
        )}

        {!isLoading && customers && customers.length > 0 && (
          <>
            {/* ── Desktop: a real table ── */}
            <table className="hidden w-full border-collapse text-left md:table">
              <caption className="sr-only">
                Customers, with order count, total spend and outstanding balance
              </caption>
              <thead>
                <tr className="border-b border-border-subtle">
                  <th scope="col" className="fd-label px-4 py-2.5 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="fd-label px-4 py-2.5 font-semibold">
                    Number
                  </th>
                  <th scope="col" className="fd-label px-4 py-2.5 text-right font-semibold">
                    Orders
                  </th>
                  <th scope="col" className="fd-label px-4 py-2.5 text-right font-semibold">
                    Spent
                  </th>
                  <th scope="col" className="fd-label px-4 py-2.5 text-right font-semibold">
                    Owes
                  </th>
                  <th scope="col" className="fd-label px-4 py-2.5 font-semibold">
                    Tags
                  </th>
                </tr>
              </thead>

              <tbody>
                {customers.map((customer) => {
                  const owes = customer.outstandingBalance ?? 0;

                  return (
                    <tr
                      key={customer.id}
                      onClick={() => navigate(`/customers/${customer.id}`)}
                      className="cursor-pointer border-b border-border-subtle transition-colors duration-fast ease-out last:border-b-0 hover:bg-surface-hover"
                    >
                      <th scope="row" className="px-4 py-2.5 font-normal">
                        <span className="flex items-center gap-2">
                          {/* The link is what makes the row keyboard-reachable;
                              the row click is a convenience on top of it. */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/customers/${customer.id}`);
                            }}
                            className="truncate text-sm font-medium text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            {customer.name ?? 'Unnamed'}
                          </button>

                          {customer.vip && (
                            <span className="shrink-0 rounded-xs bg-warning-muted px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-warning">
                              VIP
                            </span>
                          )}
                          {customer.blacklisted && (
                            <span
                              className="flex shrink-0 items-center gap-1 text-danger"
                              title="Blocked"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
                              <span className="sr-only">Blocked</span>
                            </span>
                          )}
                        </span>
                      </th>

                      <td className="fd-figure px-4 py-2.5 text-sm text-text-secondary">
                        {customer.waNumber}
                      </td>
                      <td className="fd-figure px-4 py-2.5 text-right text-sm text-text-secondary">
                        {customer.totalOrders}
                      </td>
                      <td className="fd-figure px-4 py-2.5 text-right text-sm text-text-secondary">
                        {formatCurrency(customer.totalSpend)}
                      </td>
                      <td
                        className={cn(
                          'fd-figure px-4 py-2.5 text-right text-sm',
                          owes > 0 ? 'font-semibold text-danger' : 'text-text-muted',
                        )}
                      >
                        {owes > 0 ? formatCurrency(owes) : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex flex-wrap gap-1">
                          {customer.tags.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="rounded-xs bg-surface-sunken px-1.5 py-px text-2xs text-text-secondary"
                            >
                              {t}
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* ── Phone: the same records as rows ── */}
            <RowList className="md:hidden">
              {customers.map((customer) => {
                const owes = customer.outstandingBalance ?? 0;

                return (
                  <Row
                    key={customer.id}
                    onClick={() => navigate(`/customers/${customer.id}`)}
                    className="items-start"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {customer.name ?? 'Unnamed'}
                        </span>
                        {customer.vip && (
                          <span className="shrink-0 rounded-xs bg-warning-muted px-1 py-px text-[10px] font-semibold uppercase text-warning">
                            VIP
                          </span>
                        )}
                      </span>
                      <span className="fd-figure truncate text-xs text-text-muted">
                        {customer.waNumber}
                      </span>
                      <span className="text-xs text-text-muted">
                        {customer.totalOrders} order{customer.totalOrders === 1 ? '' : 's'} ·{' '}
                        {formatCurrency(customer.totalSpend)} spent
                      </span>
                    </span>

                    <span className="shrink-0 text-right">
                      {owes > 0 ? (
                        <>
                          <span className="fd-figure block text-sm font-semibold text-danger">
                            {formatCurrency(owes)}
                          </span>
                          <span className="text-2xs text-text-muted">owed</span>
                        </>
                      ) : (
                        <span className="text-xs text-text-muted">Settled</span>
                      )}
                    </span>
                  </Row>
                );
              })}
            </RowList>
          </>
        )}
      </Panel>
    </div>
  );
}
