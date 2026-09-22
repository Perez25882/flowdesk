import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessagesSquare } from 'lucide-react';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import SearchInput from '@/components/ui/SearchInput';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import ConversationList from '@/components/messages/ConversationList';
import ConversationThread from '@/components/messages/ConversationThread';
import {
  useConversations,
  useInboxRealtime,
  useThread,
  type ConversationRow,
  type InboxFilter,
  type Thread,
} from '@/hooks/useConversations';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';

const FILTERS: readonly TabOption<InboxFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'needs_you', label: 'Needs you' },
];

/**
 * The inbox.
 *
 * This page used to be one list of every message ever received and sent,
 * newest first, each in its own card. Two things were wrong with that at any
 * volume: the shop's own replies appeared as though customers had sent them,
 * and a busy afternoon was a single wall of cards with no way to see who was
 * actually waiting. It is now one row per customer on the left and their
 * conversation on the right — the shape of every messaging app an owner
 * already knows how to use.
 *
 * The open conversation lives in the URL (`?c=`), so refreshing keeps it open,
 * the back button returns to the list on a phone, and a conversation can be
 * linked to directly.
 */
export default function MessagesPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search, 250);

  const selectedId = params.get('c');

  useInboxRealtime();
  const list = useConversations(filter, query);
  const thread = useThread(selectedId);

  const rows = useMemo(
    () => list.data?.pages.flatMap((page) => page.conversations) ?? [],
    [list.data],
  );

  function select(customerId: string | null): void {
    const next = new URLSearchParams(params);
    if (customerId) next.set('c', customerId);
    else next.delete('c');
    setParams(next);
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader title="Messages" description="Every customer who has written, newest first." />

      <div
        className={cn(
          'grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface',
          // A fixed height is what lets each pane scroll on its own. Without it
          // the whole page scrolls and the reply box drifts off-screen.
          'h-[calc(100dvh-13rem)] min-h-[28rem] lg:grid-cols-[22rem_1fr]',
        )}
      >
        <aside
          className={cn(
            'min-h-0 flex-col border-border lg:border-r',
            // On a phone the list and the thread take turns filling the screen.
            selectedId ? 'hidden lg:flex' : 'flex',
          )}
          aria-label="Conversations"
        >
          <div className="space-y-3 border-b border-border px-4 pt-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by name or number"
              label="Search conversations"
            />
            <Tabs
              options={FILTERS}
              value={filter}
              onChange={setFilter}
              label="Filter conversations"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <ListBody
              filter={filter}
              query={query}
              isLoading={list.isLoading}
              error={list.error}
              onRetry={() => void list.refetch()}
              rows={rows}
              selectedId={selectedId}
              onSelect={select}
            />

            {list.hasNextPage && (
              <div className="border-t border-border p-3 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage ? 'Loading…' : 'Show older conversations'}
                </Button>
              </div>
            )}
          </div>
        </aside>

        <section
          className={cn('min-h-0 flex-col', selectedId ? 'flex' : 'hidden lg:flex')}
          aria-label="Conversation"
        >
          <ThreadBody
            selectedId={selectedId}
            isLoading={thread.isLoading}
            error={thread.error}
            onRetry={() => void thread.refetch()}
            data={thread.data}
            onBack={() => select(null)}
          />
        </section>
      </div>
    </div>
  );
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="m-4 rounded-md border border-danger/25 bg-danger/5 px-3 py-2.5">
      <p className="text-xs font-medium text-text-primary">{what} didn&apos;t load.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1.5 text-2xs font-semibold text-danger underline-offset-2 hover:underline"
      >
        Try again
      </button>
    </div>
  );
}

function ListBody({
  filter,
  query,
  isLoading,
  error,
  onRetry,
  rows,
  selectedId,
  onSelect,
}: {
  filter: InboxFilter;
  query: string;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  rows: ConversationRow[];
  selectedId: string | null;
  onSelect: (customerId: string) => void;
}): React.JSX.Element {
  if (isLoading) return <SkeletonRows count={6} className="p-4" />;
  if (error) return <LoadError what="Conversations" onRetry={onRetry} />;

  if (rows.length === 0) {
    if (query.trim()) {
      return (
        <p className="px-4 py-8 text-center text-sm text-text-muted">
          No one matches &ldquo;{query}&rdquo;.
        </p>
      );
    }
    return filter === 'needs_you' ? (
      <EmptyState
        icon={MessagesSquare}
        title="Nothing is waiting on you"
        description="Your assistant is handling every conversation right now."
      />
    ) : (
      <EmptyState
        icon={MessagesSquare}
        title="No conversations yet"
        description="They show up here as soon as a customer messages your WhatsApp number."
      />
    );
  }

  return <ConversationList rows={rows} selectedId={selectedId} onSelect={onSelect} />;
}

function ThreadBody({
  selectedId,
  isLoading,
  error,
  onRetry,
  data,
  onBack,
}: {
  selectedId: string | null;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  data: Thread | undefined;
  onBack: () => void;
}): React.JSX.Element {
  if (!selectedId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-text-muted">Choose a conversation to read it.</p>
      </div>
    );
  }

  if (isLoading) return <SkeletonRows count={5} className="p-4" />;
  if (error || !data) return <LoadError what="This conversation" onRetry={onRetry} />;

  return <ConversationThread thread={data} onBack={onBack} />;
}
