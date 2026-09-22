import { RefreshCw, Sparkles } from 'lucide-react';
import { useLatestInsight, useRunInsight } from '@/hooks/useInsights';
import { Panel } from '@/components/ui/Panel';
import { formatCurrency } from '@/lib/utils';

/**
 * Yesterday, in a sentence.
 *
 * Sits under the setup checklist and above the figures, because it is the one
 * thing on this page that says what the numbers MEAN, the rest of the
 * dashboard shows an owner what happened and leaves them to work out whether it
 * was good.
 *
 * Nothing is shown until there is a summary. An empty "no insights yet" card
 * occupying the top of the dashboard every morning is worse than the space it
 * would fill.
 */
export default function DailyInsight(): React.JSX.Element | null {
  const { data: insight } = useLatestInsight();
  const run = useRunInsight();

  if (!insight) return null;

  const { facts } = insight;
  const written = new Date(insight.forDate);

  return (
    <Panel>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {written.toLocaleDateString('en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'short',
            })}
          </span>

          <button
            type="button"
            onClick={() => run.mutate()}
            disabled={run.isPending}
            aria-label="Write this summary again"
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${run.isPending ? 'animate-spin' : ''}`}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        </div>

        <p className="text-base font-medium leading-snug text-text-primary">{insight.headline}</p>

        {insight.body && (
          <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">
            {insight.body}
          </p>
        )}

        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border-subtle pt-3 text-xs text-text-muted">
          <span>
            Took <span className="fd-figure text-text-primary">{formatCurrency(facts.revenue)}</span>
          </span>
          <span>
            <span className="fd-figure text-text-primary">{facts.ordersCreated}</span> order
            {facts.ordersCreated === 1 ? '' : 's'}
          </span>
          <span>
            <span className="fd-figure text-text-primary">{facts.messagesIn}</span> message
            {facts.messagesIn === 1 ? '' : 's'}
          </span>
          {facts.unverifiedRepliesSent > 0 && (
            <span className="text-warning">
              <span className="fd-figure">{facts.unverifiedRepliesSent}</span> unverified repl
              {facts.unverifiedRepliesSent === 1 ? 'y' : 'ies'} sent
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}
