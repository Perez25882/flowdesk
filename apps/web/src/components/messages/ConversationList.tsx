import { UserRound } from 'lucide-react';
import type { ConversationRow } from '@/hooks/useConversations';
import { cn, customerLabel, getInitials, timeAgo } from '@/lib/utils';

/**
 * The left pane: who has written, most recent first.
 *
 * Rows separated by rules rather than a stack of cards. These are a sequence
 * ordered by time, and a divider says that; a card around each one would say
 * each is a separate object of equal weight, which is not how an owner reads an
 * inbox.
 *
 * One thing carries colour: a conversation that is waiting on the owner. It is
 * the only question anyone opens this page to answer, so it is the only row
 * that is allowed to stand out.
 */
export default function ConversationList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ConversationRow[];
  selectedId: string | null;
  onSelect: (customerId: string) => void;
}): React.JSX.Element {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.customerId}>
          <ConversationItem
            row={row}
            selected={row.customerId === selectedId}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

function ConversationItem({
  row,
  selected,
  onSelect,
}: {
  row: ConversationRow;
  selected: boolean;
  onSelect: (customerId: string) => void;
}): React.JSX.Element {
  const label = customerLabel(row);
  // Initials only from a real name. A customer with no name is shown by their
  // number, and "+2" is nobody's initials.
  const initials = row.name && /\p{L}/u.test(row.name) ? getInitials(row.name) : null;
  const preview = row.preview?.body?.trim() || (row.preview ? 'Sent a photo or file' : '');

  return (
    <button
      type="button"
      onClick={() => onSelect(row.customerId)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative flex w-full items-start gap-3 px-4 py-3 text-left',
        'transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        selected
          ? 'bg-primary-muted'
          : '[@media(hover:hover)and(pointer:fine)]:hover:bg-surface-hover',
      )}
    >
      {row.needsYou && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-accent"
        />
      )}

      <span
        aria-hidden="true"
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          row.needsYou ? 'bg-accent-light text-accent' : 'bg-surface-hover text-text-secondary',
        )}
      >
        {initials ?? <UserRound className="h-4 w-4" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm text-text-primary',
              row.needsYou ? 'font-semibold' : 'font-medium',
            )}
          >
            {label}
          </span>
          <span className="shrink-0 text-2xs text-text-muted">{timeAgo(row.lastActivityAt)}</span>
        </span>

        <span className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-text-muted">
            {row.preview?.fromShop && <span className="text-text-secondary">You: </span>}
            {preview}
          </span>
          {row.needsYou && (
            <span className="shrink-0 text-2xs font-semibold text-accent">
              {row.waiting === 1 ? 'Waiting' : `${row.waiting} waiting`}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
