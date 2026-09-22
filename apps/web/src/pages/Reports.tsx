import { useState } from 'react';
import { Download, TrendingDown, TrendingUp } from 'lucide-react';
import { downloadReportCsv, useReport, type ReportWindow } from '@/hooks/useReports';
import PageHeader from '@/components/shared/PageHeader';
import TrendChart from '@/components/shared/TrendChart';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { cn, formatCurrency } from '@/lib/utils';

const WINDOWS: ReportWindow[] = [30, 60, 90];

/**
 * How the shop is doing.
 *
 * Distinct from the dashboard, which answers "what is happening now". This
 * answers the question an owner gets asked by a landlord, a supplier offering
 * terms, or a bank, and until now the only honest answer available in Flowdesk
 * was "open the orders page and count".
 *
 * Every figure is settled money. A report that flatters by counting unverified
 * screenshots is worse than no report at all, because this is the page that
 * gets shown to somebody who will act on it.
 */
export default function ReportsPage(): React.JSX.Element {
  const [days, setDays] = useState<ReportWindow>(30);
  const [downloading, setDownloading] = useState(false);
  const { data: report, isLoading } = useReport(days);

  async function handleDownload(): Promise<void> {
    if (!report) return;
    setDownloading(true);
    try {
      await downloadReportCsv(days, `flowdesk-${report.from}-to-${report.to}.csv`);
    } finally {
      setDownloading(false);
    }
  }

  const revenueChange =
    report && report.previous.revenue > 0
      ? ((report.revenue - report.previous.revenue) / report.previous.revenue) * 100
      : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Reports"
        description="Revenue and orders over time, and the file to send on."
        actions={
          <>
            <span className="flex items-center rounded-md border border-border" role="group" aria-label="Period">
              {WINDOWS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDays(option)}
                  aria-pressed={days === option}
                  className={cn(
                    'h-9 px-3 text-sm transition-colors first:rounded-l-[5px] last:rounded-r-[5px]',
                    days === option
                      ? 'bg-primary text-white'
                      : 'text-text-secondary hover:bg-surface-hover',
                  )}
                >
                  {option}d
                </button>
              ))}
            </span>

            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handleDownload()}
              disabled={!report}
              isLoading={downloading}
              leadingIcon={<Download className="h-4 w-4" strokeWidth={2} />}
            >
              Export CSV
            </Button>
          </>
        }
      />

      {isLoading && (
        <Panel>
          <SkeletonRows count={4} />
        </Panel>
      )}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label={`Money in, ${days} days`}
              value={formatCurrency(report.revenue)}
              change={revenueChange}
            />
            <Figure
              label="Orders"
              value={String(report.orders)}
              note={`${report.ordersCompleted} completed · ${report.ordersPending} open`}
            />
            <Figure
              label="Average order"
              value={formatCurrency(report.averageOrderValue)}
              note={report.ordersCancelled > 0 ? `${report.ordersCancelled} cancelled, excluded` : undefined}
            />
            <Figure
              label="Still owed"
              value={formatCurrency(report.outstanding)}
              note="Payment links nobody has paid"
            />
          </div>

          <Panel>
            <PanelHead title="Money in" meta={`${report.from} to ${report.to}`} />
            <div className="p-4">
              <TrendChart
                points={report.series.map((point) => ({ date: point.date, value: point.revenue }))}
                label={`Money received per day over ${days} days`}
                formatValue={(value) => formatCurrency(value)}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHead title="Orders per day" />
            <div className="p-4">
              <TrendChart
                points={report.series.map((point) => ({ date: point.date, value: point.orders }))}
                label={`Orders per day over ${days} days`}
                formatValue={(value) => String(Math.round(value))}
                height={100}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHead title="What sold" meta={`Top ${report.topProducts.length}`} />
            {report.topProducts.length === 0 ? (
              <p className="p-4 text-sm text-text-muted">
                Nothing sold in this period.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {report.topProducts.map((product) => (
                  <li key={product.name} className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                      {product.name}
                    </span>
                    <span className="fd-figure shrink-0 text-xs text-text-muted">
                      {product.quantity}
                    </span>
                    <span className="fd-figure shrink-0 text-sm font-medium text-text-primary">
                      {formatCurrency(product.value)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  change,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  /** Percentage against the previous period of the same length. */
  change?: number | null | undefined;
}): React.JSX.Element {
  const rising = typeof change === 'number' && change > 0;
  const falling = typeof change === 'number' && change < 0;

  return (
    <Panel>
      <div className="flex flex-col gap-1 p-4">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="fd-figure text-2xl font-semibold text-text-primary">{value}</span>

        {typeof change === 'number' && (
          <span
            className={cn(
              'flex items-center gap-1 text-xs',
              rising ? 'text-success' : falling ? 'text-warning' : 'text-text-muted',
            )}
          >
            {rising ? (
              <TrendingUp className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            ) : falling ? (
              <TrendingDown className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            ) : null}
            <span className="fd-figure">{Math.abs(Math.round(change))}%</span> vs the period before
          </span>
        )}

        {note && <span className="text-xs text-text-muted">{note}</span>}
      </div>
    </Panel>
  );
}
