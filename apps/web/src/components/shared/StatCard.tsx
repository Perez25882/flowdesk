import { TrendingUp, TrendingDown, type LucideIcon } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: number;
  icon?: LucideIcon;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const variantMap = {
  default: {
    iconBg: 'bg-[var(--color-primary-muted)]',
    iconColor: 'text-[var(--color-primary-light)]',
  },
  success: {
    iconBg: 'bg-[var(--color-success-muted)]',
    iconColor: 'text-[var(--color-success)]',
  },
  warning: {
    iconBg: 'bg-[var(--color-warning-muted)]',
    iconColor: 'text-[var(--color-warning)]',
  },
  danger: {
    iconBg: 'bg-[var(--color-danger-muted)]',
    iconColor: 'text-[var(--color-danger)]',
  },
};

export default function StatCard({
  label,
  value,
  subtext,
  trend,
  icon: Icon,
  variant = 'default',
}: StatCardProps): React.JSX.Element {
  const styles = variantMap[variant];
  const isPositive = trend !== undefined && trend >= 0;
  const trendColor = isPositive ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]';
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:bg-[var(--color-surface-hover)]">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </span>
          <span className="font-mono text-2xl font-semibold text-[var(--color-text-primary)]">
            {value}
          </span>
        </div>
        {Icon && (
          <div className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] ${styles.iconBg}`}>
            <Icon className={`h-5 w-5 ${styles.iconColor}`} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {trend !== undefined && (
          <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${trendColor}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            {isPositive ? '+' : ''}
            {trend.toFixed(1)}%
          </span>
        )}
        {subtext && (
          <span className="text-xs text-[var(--color-text-secondary)]">
            {subtext}
          </span>
        )}
      </div>
    </div>
  );
}
