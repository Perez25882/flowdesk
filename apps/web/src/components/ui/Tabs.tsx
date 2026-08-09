import { cn } from '@/lib/utils';

/**
 * Segmented filter for switching a view between mutually exclusive states.
 *
 * The active tab is marked by a rule directly under the label, not by a filled
 * pill. A pill competes with the primary button for attention; an underline
 * says "you are here" and nothing else. Counts sit beside the label so the
 * user can see where the work is before committing to a click.
 */

export interface TabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the group for assistive tech, e.g. "Filter orders by status". */
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        '-mb-px flex gap-1 overflow-x-auto border-b border-border',
        // Hide the horizontal scrollbar on the mobile tab strip; the overflow
        // is already signalled by a partially visible tab at the edge.
        '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative shrink-0 whitespace-nowrap px-3 pb-2.5 pt-1.5 text-sm font-medium',
              'transition-colors duration-fast ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              isActive
                ? 'text-text-primary'
                : 'text-text-secondary [@media(hover:hover)and(pointer:fine)]:hover:text-text-primary',
            )}
          >
            <span className="flex items-center gap-1.5">
              {option.label}
              {option.count !== undefined && option.count > 0 ? (
                <span
                  className={cn(
                    'fd-figure rounded-sm px-1 py-px text-2xs font-semibold',
                    isActive ? 'bg-primary-light text-primary' : 'bg-surface-sunken text-text-muted',
                  )}
                >
                  {option.count}
                </span>
              ) : null}
            </span>

            {/* The indicator overlaps the container's bottom border exactly. */}
            <span
              aria-hidden="true"
              className={cn(
                'absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-opacity duration-fast ease-out',
                isActive ? 'bg-primary opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
