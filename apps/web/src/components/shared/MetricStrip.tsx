import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The figures that head a page.
 *
 * Previously these were four identical cards in a four-up grid, each with its
 * own border, its own coloured icon chip and its own drop shadow. That layout
 * gives every number the same weight, which is exactly wrong: today's revenue
 * and the count of unverified payments are not equally important, and a shop
 * owner opening this at 6am needs to know which one to look at first.
 *
 * So: one strip, divided by hairlines. Figures are set in the mono face at a
 * size that makes them the loudest thing on the page. One metric may be marked
 * `emphasis` to take a wider column and a larger figure. Icons are gone
 * entirely, a shopping-cart glyph next to the words "Orders today" carries no
 * information that the words do not.
 */

export interface MetricProps {
  label: string;
  value: string | number;
  /** Supporting figure or qualifier, e.g. a total value behind a count. */
  detail?: string;
  /** Colours the figure. Reserved for genuinely abnormal states. */
  tone?: 'default' | 'success' | 'warning' | 'danger';
  /** Rendered under the detail line, e.g. a "Review" link. */
  action?: ReactNode;
}

const TONE_CLASSES: Record<NonNullable<MetricProps['tone']>, string> = {
  default: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function Metric({
  label,
  value,
  detail,
  tone = 'default',
  action,
  emphasis = false,
}: MetricProps & { emphasis?: boolean }): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col justify-between gap-3 px-4 py-4 md:px-5',
        emphasis && 'md:py-5',
      )}
    >
      <span className="fd-label">{label}</span>

      <div className="flex flex-col gap-0.5">
        {/* Figures step down on a phone. "GHS 4,182.50" set at 30px mono needs
            about 210px; a half-width column at 375px gives it 165px, so the
            emphasised metric overflowed its own cell. The size only grows once
            there is room for it. */}
        <span
          className={cn(
            'fd-figure font-extrabold leading-none tracking-tighter',
            emphasis ? 'text-xl sm:text-2xl md:text-3xl' : 'text-lg sm:text-xl md:text-2xl',
            TONE_CLASSES[tone],
          )}
        >
          {value}
        </span>
        {detail ? <span className="truncate text-xs text-text-muted">{detail}</span> : null}
        {action}
      </div>
    </div>
  );
}

/**
 * Wraps metrics in a single ruled container. On narrow screens it becomes two
 * columns, because four stacked full-width figures push everything below the
 * fold on a phone.
 */
export function MetricStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section
      className={cn(
        'fd-panel grid grid-cols-2 overflow-hidden',
        'divide-x divide-y divide-border-subtle',
        '[&>*:nth-child(-n+2)]:border-t-0',
        'md:grid-cols-4 md:divide-y-0 md:[&>*]:border-t-0',
        className,
      )}
    >
      {children}
    </section>
  );
}
