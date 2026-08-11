import { useState } from 'react';
import { Check, CreditCard, ImageIcon, Trash2 } from 'lucide-react';
import { PAYMENT_CONFIDENCE_LABELS } from '@flowdesk/shared';
import {
  usePayments,
  useAttestPayment,
  useVoidPayment,
  useRevenueStats,
} from '@/hooks/usePayments';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import { Metric, MetricStrip } from '@/components/shared/MetricStrip';
import { Panel, Row, RowList } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { Badge } from '@/components/ui/Badge';
import { useTabParam } from '@/hooks/useTabParam';
import { formatCurrency } from '@/lib/utils';

type PaymentTab = 'all' | 'review';
const PAYMENT_TABS = ['all', 'review'] as const;

const METHOD_LABEL: Record<string, string> = {
  MOMO_MTN: 'MTN MoMo',
  MOMO_VODAFONE: 'Telecel Cash',
  MOMO_AIRTELTIGO: 'AirtelTigo Money',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

/**
 * The money.
 *
 * Deleting a payment used to be a single unlabelled red icon button sitting
 * beside the verify button, with no confirmation — one mis-tap on a phone and
 * a customer's record silently loses a payment. It now confirms first, and
 * both actions state what they do.
 */
export default function PaymentsPage(): React.JSX.Element {
  const [tab, setTab] = useTabParam<PaymentTab>('view', PAYMENT_TABS, 'all');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data: allPayments, isLoading: allLoading } = usePayments();
  const { data: reviewPayments, isLoading: reviewLoading } = usePayments(false, true);
  const { data: stats } = useRevenueStats();
  const attest = useAttestPayment();
  const voidPayment = useVoidPayment();

  const payments = tab === 'review' ? reviewPayments : allPayments;
  const isLoading = tab === 'review' ? reviewLoading : allLoading;

  const tabOptions: readonly TabOption<PaymentTab>[] = [
    { value: 'all', label: 'All payments' },
    { value: 'review', label: 'Needs checking', count: reviewPayments?.length ?? 0 },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Payments"
        description="What came in, and what needs checking."
      />

      {stats && (
        <MetricStrip>
          <Metric label="Today" value={formatCurrency(stats.today)} emphasis />
          <Metric label="This week" value={formatCurrency(stats.thisWeek)} />
          <Metric label="This month" value={formatCurrency(stats.thisMonth)} />
          <Metric label="All time" value={formatCurrency(stats.totalRevenue)} />
        </MetricStrip>
      )}

      <div>
        <Tabs label="Filter payments" options={tabOptions} value={tab} onChange={setTab} />

        <Panel className="mt-4">
          {isLoading && <SkeletonRows count={6} />}

          {!isLoading && (!payments || payments.length === 0) && (
            <EmptyState
              icon={CreditCard}
              title={tab === 'review' ? 'Nothing to check' : 'No payments yet'}
              description={
                tab === 'review'
                  ? 'Everything is matched and confirmed.'
                  : 'Payments appear as you record them against orders.'
              }
            />
          )}

          {!isLoading && payments && payments.length > 0 && (
            <RowList>
              {payments.map((payment) => {
                const isConfirming = confirmingId === payment.id;

                return (
                  <Row key={payment.id} className="flex-wrap gap-y-2">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {payment.customer.name ?? payment.customer.waNumber}
                        </span>
                        {payment.voidedAt ? (
                          <Badge tone="neutral">Voided</Badge>
                        ) : payment.confidence === 'CLAIMED' ? (
                          <Badge tone="warning">{PAYMENT_CONFIDENCE_LABELS.CLAIMED}</Badge>
                        ) : (
                          <Badge tone="success">{PAYMENT_CONFIDENCE_LABELS[payment.confidence]}</Badge>
                        )}
                        {payment.screenshotUrl && (
                          <span
                            className="flex items-center text-text-muted"
                            title="Customer sent a screenshot"
                          >
                            <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
                            <span className="sr-only">Has a screenshot attached</span>
                          </span>
                        )}
                      </span>
                      <span className="truncate text-xs text-text-muted">
                        {METHOD_LABEL[payment.method] ?? payment.method}
                        {payment.reference && ` · ${payment.reference}`}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-2">
                      <span className="fd-figure text-sm font-semibold text-text-primary">
                        {formatCurrency(payment.amount)}
                      </span>

                      {isConfirming ? (
                        // Inline confirmation rather than a modal: the row is
                        // already the subject, so a dialog would only restate it.
                        // The reason itself is collected via window.prompt — a
                        // stopgap until a proper dialog lands in a later phase.
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs text-text-secondary">Void this?</span>
                          <button
                            type="button"
                            onClick={() => {
                              const reason = window.prompt('Why is this payment being voided?');
                              setConfirmingId(null);
                              if (reason === null) return;
                              const trimmed = reason.trim();
                              if (!trimmed) return;
                              voidPayment.mutate({ id: payment.id, reason: trimmed });
                            }}
                            className="min-h-[36px] rounded-sm bg-danger px-2.5 text-xs font-bold text-white transition-transform duration-instant ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                          >
                            Void
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            className="min-h-[36px] rounded-sm px-2.5 text-xs font-medium text-text-secondary transition-colors duration-fast ease-out hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <>
                          {payment.confidence === 'CLAIMED' && payment.voidedAt === null && (
                            <button
                              type="button"
                              onClick={() => attest.mutate(payment.id)}
                              aria-label={`Confirm ${formatCurrency(payment.amount)} from ${payment.customer.name ?? payment.customer.waNumber} landed`}
                              className="flex h-11 items-center gap-1.5 rounded-md border border-success-border bg-success-muted px-2.5 text-xs font-bold text-success transition-transform duration-instant ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success sm:h-8 sm:px-2"
                            >
                              <Check className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
                              Confirm
                            </button>
                          )}

                          {payment.voidedAt === null && (
                            <button
                              type="button"
                              onClick={() => setConfirmingId(payment.id)}
                              aria-label={`Void the ${formatCurrency(payment.amount)} payment from ${payment.customer.name ?? payment.customer.waNumber}`}
                              className="flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors duration-fast ease-out hover:bg-danger-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-8 sm:w-8"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </Row>
                );
              })}
            </RowList>
          )}
        </Panel>
      </div>
    </div>
  );
}
