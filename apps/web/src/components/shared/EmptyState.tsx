import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  /**
   * `inline` sits inside a panel that already has a heading, so it stays
   * quiet. `page` owns the whole view and is allowed more presence.
   */
  variant?: 'inline' | 'page';
  className?: string;
}

/**
 * Empty states.
 *
 * Deliberately not the icon-in-a-rounded-tile pattern. An empty list on an
 * operations screen is usually good news, no pending orders means the morning
 * is clear, so it should read as a calm statement of fact, not as a gap
 * apologising for itself.
 *
 * The icon, where present, is drawn on the rule rather than mounted in a
 * coloured chip, and it is always paired with text that stands on its own.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'inline',
  className,
}: EmptyStateProps): React.JSX.Element {
  const isPage = variant === 'page';

  return (
    <div
      className={cn(
        'flex flex-col items-start',
        isPage ? 'gap-3 px-6 py-16' : 'gap-2 px-4 py-10',
        className,
      )}
    >
      {Icon ? (
        <Icon
          className={cn('text-text-muted', isPage ? 'h-6 w-6' : 'h-5 w-5')}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      ) : null}

      <div className="flex flex-col gap-1">
        <h3
          className={cn(
            'font-bold tracking-tight text-text-primary',
            isPage ? 'text-lg' : 'text-base',
          )}
        >
          {title}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary">{description}</p>
      </div>

      {action ? (
        <Button size="sm" variant="secondary" onClick={action.onClick} className="mt-1.5">
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
