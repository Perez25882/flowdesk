import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { useCustomerInsights } from '@/hooks/useCustomerInsights';
import { Panel, PanelHead } from '@/components/ui/Panel';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { cn, formatCurrency } from '@/lib/utils';

/**
 * Who the customers are, and where the conversations die.
 *
 * Two questions, and the second is the one nobody can currently answer. A shop
 * sees a hundred conversations and eight orders and has no way to find out
 * which step lost the other ninety-two.
 *
 * "Going quiet" is deliberately a list of names rather than a number. A count
 * of at-risk customers is a statistic; a name, what they usually spend and how
 * long it has been is something an owner can act on in the next ten minutes,
 * which is the only kind of insight that changes anything.
 */
export default function CustomerInsights(): React.JSX.Element {
  const { data, isLoading } = useCustomerInsights();

  if (isLoading) {
    return (
      <Panel>
        <SkeletonRows count={4} />
      </Panel>
    );
  }

  if (!data) return <></>;

  const topOfFunnel = data.funnel[0]?.reached ?? 0;
  const worst = data.worstStep;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* An empty segment is honest but not worth a tile. The counts are
            still complete server-side; this is only what gets screen space. */}
        {data.segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <Panel key={segment.segment}>
              <div className="flex flex-col gap-1 p-4">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-text-primary">{segment.title}</span>
                  <span
                    className={cn(
                      'fd-figure text-2xl font-semibold',
                      segment.segment === 'at_risk' ? 'text-warning' : 'text-text-primary',
                    )}
                  >
                    {segment.count}
                  </span>
                </span>
                <span className="text-xs text-text-muted">{segment.blurb}</span>
                {segment.value > 0 && (
                  <span className="fd-figure text-xs text-text-muted">
                    {formatCurrency(segment.value)} spent between them
                  </span>
                )}
              </div>
            </Panel>
          ))}
      </div>

      <Panel>
        <PanelHead
          title="Going quiet"
          meta={data.goingQuiet.length > 0 ? String(data.goingQuiet.length) : undefined}
        />

        {data.goingQuiet.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">
            Nobody is overdue against their usual pattern. That is the good version of this list.
          </p>
        ) : (
          <>
            <p className="border-b border-border-subtle px-4 py-2 text-xs text-text-muted">
              These people buy on a rhythm and have gone past it. Most valuable first.
            </p>
            <ul className="divide-y divide-border-subtle">
              {data.goingQuiet.map((customer) => (
                <li key={customer.id} className="flex items-center gap-3 px-4 py-3">
                  <Link
                    to={`/customers/${customer.id}`}
                    className="min-w-0 flex-1 truncate text-sm text-text-primary hover:underline"
                  >
                    {customer.name || customer.waNumber}
                  </Link>

                  <span className="shrink-0 text-xs text-text-muted">
                    {customer.daysSilent !== null && `${customer.daysSilent}d quiet`}
                    {customer.typicalGapDays !== null &&
                      ` · usually every ${customer.typicalGapDays}d`}
                  </span>

                  <span className="fd-figure shrink-0 text-sm font-medium text-text-primary">
                    {formatCurrency(customer.totalSpend)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel>
        <PanelHead title="Where conversations stop" />

        <div className="flex flex-col gap-2 p-4">
          {data.funnel.map((step) => {
            const width = topOfFunnel > 0 ? (step.reached / topOfFunnel) * 100 : 0;

            return (
              <div key={step.stage} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-text-primary">{step.label}</span>
                  <span className="fd-figure text-text-secondary">
                    {step.reached}
                    {step.stoppedHere > 0 && (
                      <span className="ml-2 text-xs text-text-muted">
                        {step.stoppedHere} stopped here
                      </span>
                    )}
                  </span>
                </div>
                {/* Scaled against the top of the funnel, so the bars are
                    comparable. A bar scaled to its own step looks full at every
                    step and says nothing. */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${width}%` }}
                    role="presentation"
                  />
                </div>
              </div>
            );
          })}

          {worst && (
            <p className="mt-2 flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-sm text-text-secondary">
              <MessageCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span>
                Your biggest loss is between{' '}
                <span className="font-medium text-text-primary">
                  {data.funnel.find((s) => s.stage === worst.from)?.label.toLowerCase()}
                </span>{' '}
                and{' '}
                <span className="font-medium text-text-primary">
                  {data.funnel.find((s) => s.stage === worst.to)?.label.toLowerCase()}
                </span>
                : <span className="fd-figure">{worst.lost}</span> people, which is{' '}
                <span className="fd-figure">{Math.round(worst.rate * 100)}%</span> of everyone
                who got that far.
              </span>
            </p>
          )}

          {data.truncated && (
            <p className="text-xs text-text-muted">
              You have more customers than this page reads at once. These figures cover your most
              recent ones.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
