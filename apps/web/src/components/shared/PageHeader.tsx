import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The head of every page.
 *
 * Each page owns its own header rather than inheriting a title from the top
 * bar. That is what gives a page room for a sentence of context and for the
 * actions that belong to it, instead of pushing every control into a single
 * global toolbar where a "New order" button sits next to "Sign out".
 *
 * The title is set at 22px semibold with tight tracking — large enough to
 * anchor the page, small enough that it never competes with the figures
 * underneath it, which are the actual content.
 */
export default function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 pb-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold tracking-tighter text-text-primary">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </header>
  );
}
