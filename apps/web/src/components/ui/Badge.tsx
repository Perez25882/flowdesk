import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status tag.
 *
 * Always renders a text label alongside the colour. Colour on its own is
 * invisible to colour-blind users and washes out on a cheap screen in
 * sunlight — which is exactly where this product is used.
 *
 * Squared rather than pill-shaped: a pill reads as a marketing badge, a
 * rectangle reads as a record field. This is a ledger.
 */

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'processing';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-text-secondary border-border',
  primary: 'bg-primary-light text-primary border-primary-border',
  success: 'bg-success-muted text-success border-success-border',
  warning: 'bg-warning-muted text-warning border-warning-border',
  danger: 'bg-danger-muted text-danger border-danger-border',
  info: 'bg-info-muted text-info border-info-border',
  processing:
    'bg-[var(--color-processing-muted)] text-[var(--color-status-processing)] border-[var(--color-processing-border)]',
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-text-muted',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  processing: 'bg-[var(--color-status-processing)]',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Adds a leading dot — useful in dense lists where the tag is small. */
  withDot?: boolean;
  className?: string;
}

export function Badge({
  tone = 'neutral',
  children,
  withDot = false,
  className,
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-[3px]',
        'text-2xs font-semibold uppercase tracking-wide whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {withDot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONES[tone])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

/**
 * The dot alone, for rows too tight to carry a full tag. The status must
 * still be stated in text somewhere in the same row.
 */
export function StatusDot({
  tone = 'neutral',
  className,
}: {
  tone?: BadgeTone;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONES[tone], className)}
    />
  );
}

/** Maps an order status to its tag tone and human-readable label. */
export const ORDER_STATUS_TONE: Record<string, { tone: BadgeTone; label: string }> = {
  PENDING: { tone: 'warning', label: 'Pending' },
  CONFIRMED: { tone: 'info', label: 'Confirmed' },
  PROCESSING: { tone: 'processing', label: 'Processing' },
  FULFILLED: { tone: 'success', label: 'Fulfilled' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

export function OrderStatusBadge({ status }: { status: string }): React.JSX.Element {
  const config = ORDER_STATUS_TONE[status] ?? { tone: 'neutral' as BadgeTone, label: status };
  return (
    <Badge tone={config.tone} withDot>
      {config.label}
    </Badge>
  );
}
