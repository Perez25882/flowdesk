import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-surface-elevated)]">
        <Icon className="h-7 w-7 text-[var(--color-text-muted)]" />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-[var(--color-text-primary)]">
          {title}
        </h3>
        <p className="max-w-[280px] text-sm text-[var(--color-text-secondary)]">
          {description}
        </p>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-light)]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
