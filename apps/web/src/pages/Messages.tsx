import { useMemo, useState } from 'react';
import { MessageSquare, AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { useMessages, useCorrectMessageIntent } from '@/hooks/useMessages';
import EmptyState from '@/components/shared/EmptyState';
import { timeAgo } from '@/lib/utils';

const INTENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'ORDER', label: 'Order' },
  { value: 'INQUIRY', label: 'Inquiry' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'COMPLAINT', label: 'Complaint' },
  { value: 'CANCEL', label: 'Cancel' },
  { value: 'GREETING', label: 'Greeting' },
  { value: 'THANKS', label: 'Thanks' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNCLASSIFIED', label: 'Unclassified' },
];

const intentColor: Record<string, string> = {
  ORDER: 'text-[var(--color-success)]',
  PAYMENT: 'text-[var(--color-warning)]',
  COMPLAINT: 'text-[var(--color-danger)]',
  UNCLASSIFIED: 'text-[var(--color-text-muted)]',
};

export default function MessagesPage(): React.JSX.Element {
  const [tab, setTab] = useState<'all' | 'review'>('all');
  const [search, setSearch] = useState('');
  const { data: allMessages, isLoading: allLoading } = useMessages();
  const { data: reviewMessages, isLoading: reviewLoading } = useMessages(true);
  const correctIntent = useCorrectMessageIntent();

  const messages = tab === 'review' ? reviewMessages : allMessages;
  const isLoading = tab === 'review' ? reviewLoading : allLoading;

  const filtered = useMemo(() => {
    if (!messages) return [];
    if (!search.trim()) return messages;
    const q = search.toLowerCase();
    return messages.filter((m) => {
      const name = (m.customer?.name ?? '').toLowerCase();
      const phone = m.customer?.waNumber ?? '';
      const body = (m.body ?? '').toLowerCase();
      return name.includes(q) || phone.includes(q) || body.includes(q);
    });
  }, [messages, search]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Messages</h1>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setTab('all')}
          className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors ${
            tab === 'all'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          All
      </button>
        <button
          onClick={() => setTab('review')}
          className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors ${
            tab === 'review'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          Needs Review {reviewMessages && reviewMessages.length > 0 ? `(${reviewMessages.length})` : ''}
      </button>

        <div className="relative ml-auto max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number, or text..."
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
          />
      </div>
    </div>

      {isLoading && (
        <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />
      )}

      {!isLoading && filtered.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          title={search ? 'No matches' : tab === 'review' ? 'No messages to review' : 'No messages yet'}
          description={
            search
              ? 'Try a different search term.'
              : tab === 'review'
              ? 'All messages have been classified.'
              : 'Messages appear when customers contact you on WhatsApp.'
          }
        />
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((msg) => {
            const isPending = correctIntent.isPending && correctIntent.variables?.id === msg.id;
            const customerLabel = msg.customer?.name ?? msg.customer?.waNumber ?? 'Unknown';
            return (
              <div
                key={msg.id}
                className={`rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 ${
                  msg.requiresReview ? 'border-l-4 border-l-[var(--color-warning)]' : ''
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">
                      {customerLabel}
                  </span>
                    <span className={`text-xs font-semibold uppercase ${intentColor[msg.intent] ?? 'text-[var(--color-text-muted)]'}`}>
                      {msg.intent}
                  </span>
                    {msg.requiresReview && <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-warning)]" />}
                    {typeof msg.intentConfidence === 'number' && (
                      <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {Math.round(msg.intentConfidence * 100)}% conf
                    </span>
                    )}
                </div>
                  <span className="text-xs text-[var(--color-text-muted)]">{timeAgo(msg.createdAt)}</span>
              </div>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{msg.body ?? '(no text)'}</p>

                {msg.requiresReview && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-warning-muted)] px-3 py-2">
                    <span className="text-xs font-medium text-[var(--color-warning)]">Correct intent</span>
                    <select
                      disabled={isPending}
                      defaultValue=""
                      onChange={(e) => {
                        const intent = e.target.value;
                        if (!intent) return;
                        correctIntent.mutate({ id: msg.id, intent });
                        e.target.value = '';
                      }}
                      className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                    >
                      <option value="" disabled>
                        Pick correct intent
                    </option>
                      {INTENT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                      </option>
                      ))}
                  </select>
                    {correctIntent.isSuccess && correctIntent.variables?.id === msg.id && (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--color-success)]">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Updated
                    </span>
                    )}
                    {correctIntent.isError && correctIntent.variables?.id === msg.id && (
                      <span className="text-xs text-[var(--color-danger)]">
                        {(correctIntent.error as Error).message}
                    </span>
                    )}
                </div>
                )}
            </div>
            );
          })}
      </div>
      )}
  </div>
  );
}
