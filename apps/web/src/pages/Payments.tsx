import { useState } from 'react';
import { CreditCard, Check, Trash2, Image } from 'lucide-react';
import { usePayments, useVerifyPayment, useDeletePayment, useRevenueStats } from '@/hooks/usePayments';
import EmptyState from '@/components/shared/EmptyState';
import { formatCurrency } from '@/lib/utils';

export default function PaymentsPage(): React.JSX.Element {
  const [tab, setTab] = useState<'all' | 'review'>('all');
  const { data: allPayments, isLoading: allLoading } = usePayments();
  const { data: reviewPayments, isLoading: reviewLoading } = usePayments(false, true);
  const { data: stats } = useRevenueStats();
  const verify = useVerifyPayment();
  const deletePayment = useDeletePayment();

  const payments = tab === 'review' ? reviewPayments : allPayments;
  const isLoading = tab === 'review' ? reviewLoading : allLoading;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Payments</h1>

      {stats && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">Today</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{formatCurrency(stats.today)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">This Week</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{formatCurrency(stats.thisWeek)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">This Month</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{formatCurrency(stats.thisMonth)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-center">
            <p className="text-xs text-[var(--color-text-muted)]">Total</p>
            <p className="mt-1 text-lg font-semibold text-[var(--color-text-primary)]">{formatCurrency(stats.totalRevenue)}</p>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={() => setTab('all')} className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium ${tab === 'all' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]'}`}>All Payments</button>
        <button onClick={() => setTab('review')} className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium ${tab === 'review' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]'}`}>
          Screenshot Review {reviewPayments && reviewPayments.length > 0 ? `(${reviewPayments.length})` : ''}
        </button>
      </div>

      {isLoading && <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />}
      {!isLoading && (!payments || payments.length === 0) && (
        <EmptyState icon={CreditCard} title={tab === 'review' ? 'Nothing to review' : 'No payments yet'} description={tab === 'review' ? 'All payments have been verified.' : 'Payments appear when you log them from an order or customer record.'} />
      )}

      {!isLoading && payments && payments.length > 0 && (
        <div className="space-y-2">
          {payments.map((payment) => (
            <div key={payment.id} className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {payment.customer.name ?? payment.customer.waNumber}
                  </span>
                  {payment.verified && <span className="rounded-[var(--radius-sm)] bg-[var(--color-success-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-success)]">Verified</span>}
                  {payment.screenshotUrl && <Image className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />}
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{payment.method} {payment.reference && `(${payment.reference})`}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-medium text-[var(--color-text-primary)]">{formatCurrency(payment.amount)}</span>
                {!payment.verified && (
                  <button onClick={() => verify.mutate(payment.id)} className="rounded-[var(--radius-sm)] bg-[var(--color-success-muted)] p-1.5 hover:bg-[var(--color-success)]/20">
                    <Check className="h-4 w-4 text-[var(--color-success)]" />
                  </button>
                )}
                <button onClick={() => deletePayment.mutate(payment.id)} className="rounded-[var(--radius-sm)] bg-[var(--color-danger-muted)] p-1.5 hover:bg-[var(--color-danger)]/20">
                  <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
