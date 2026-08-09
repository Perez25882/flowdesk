import { cn } from '@/lib/utils';

/**
 * Loading placeholders.
 *
 * These mirror the shape of the content that replaces them, so nothing shifts
 * when the data lands. A centred spinner tells the user only that something is
 * happening; a skeleton tells them what is about to arrive and how much of it.
 *
 * They pulse rather than shimmer. A sweeping shimmer draws the eye to the one
 * thing on the page worth ignoring.
 */

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('fd-skeleton block', className)} />;
}

/** A run of list rows matching the geometry of `Row`. */
export function SkeletonRows({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('divide-y divide-border-subtle', className)} role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {/* Widths vary so the block does not read as a printed pattern. */}
            <Skeleton className={cn('h-3.5', i % 3 === 0 ? 'w-40' : i % 3 === 1 ? 'w-52' : 'w-32')} />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-3.5 w-16 shrink-0" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Card-shaped placeholders, for the order board columns. */
export function SkeletonCards({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-md border border-border-subtle bg-surface p-3">
          <div className="mb-2.5 flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-10" />
          </div>
          <Skeleton className="mb-1.5 h-3.5 w-28" />
          <Skeleton className="mb-3 h-2.5 w-36" />
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading orders</span>
    </div>
  );
}
