import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Panel, the workhorse container.
 *
 * A hairline border and a white ground. No shadow: a panel does not float, it
 * sits on the page. Elevation is reserved for drawers, dialogs and menus, so
 * that when something *does* lift, it means something.
 *
 * The old dashboard nested bordered cards inside bordered cards, which is the
 * fastest way to make an interface look assembled rather than designed. Rows
 * inside a Panel are separated by rules instead.
 */

export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}): React.JSX.Element {
  return <Tag className={cn('fd-panel overflow-hidden', className)}>{children}</Tag>;
}

/**
 * Panel header. Title on the left, optional action on the right, sitting on a
 * rule. Deliberately not uppercase, when every panel head was uppercase and
 * letterspaced they all read at the same weight and the page had no shape.
 */
export function PanelHead({
  title,
  meta,
  action,
  className,
}: {
  title: ReactNode;
  /** Secondary figure or count, set beside the title on the same baseline. */
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <header className={cn('fd-panel-head', className)}>
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 className="fd-panel-title truncate">{title}</h2>
        {meta ? <span className="text-xs text-text-muted">{meta}</span> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
    </header>
  );
}

export function PanelBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={cn('p-4', className)}>{children}</div>;
}

/**
 * A list of rules rather than a stack of cards. `divide` on the parent means
 * the last row never carries a trailing border.
 */
export function RowList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn('divide-y divide-border-subtle', className)}
      // Rows below the fold are not laid out or painted until they scroll
      // near it. On a 400-customer list this is the difference between a
      // janky first paint and an instant one, without virtualising.
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 3000px' }}
    >
      {children}
    </div>
  );
}

export function Row({
  children,
  className,
  onClick,
  as,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  as?: 'div' | 'li';
}): React.JSX.Element {
  const base = 'flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-fast ease-out';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          base,
          'w-full text-left',
          '[@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          className,
        )}
      >
        {children}
      </button>
    );
  }

  const Tag = as ?? 'div';
  return <Tag className={cn(base, className)}>{children}</Tag>;
}
