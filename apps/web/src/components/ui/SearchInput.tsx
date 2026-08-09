import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Search field.
 *
 * `type="search"` rather than `type="text"` so mobile keyboards offer a Search
 * key and the field gets native clear behaviour, plus an explicit clear button
 * because the native one is invisible on Android.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Names the field for assistive tech; the placeholder is not a label. */
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
        strokeWidth={1.75}
        aria-hidden="true"
      />

      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className={cn(
          'fd-input fd-input-compact h-10 py-0 pl-9 sm:h-9',
          value ? 'pr-9' : 'pr-3',
          // The WebKit clear affordance is styled inconsistently across
          // browsers; the explicit button below replaces it.
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />

      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-text-muted transition-colors duration-fast ease-out hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
