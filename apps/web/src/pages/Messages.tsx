import { useState } from 'react';
import { MessageSquare, AlertTriangle } from 'lucide-react';
import { useMessages } from '@/hooks/useMessages';
import EmptyState from '@/components/shared/EmptyState';
import { timeAgo } from '@/lib/utils';

export default function MessagesPage(): React.JSX.Element {
  const [tab, setTab] = useState<'all' | 'review'>('all');
  const { data: allMessages, isLoading: allLoading } = useMessages();
  const { data: reviewMessages, isLoading: reviewLoading } = useMessages(true);

  const messages = tab === 'review' ? reviewMessages : allMessages;
  const isLoading = tab === 'review' ? reviewLoading : allLoading;

  const intentColor: Record<string, string> = {
    ORDER: 'text-[var(--color-success)]',
    PAYMENT: 'text-[var(--color-warning)]',
    COMPLAINT: 'text-[var(--color-danger)]',
    UNCLASSIFIED: 'text-[var(--color-text-muted)]',
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Messages</h1>

      <div className="flex gap-2">
        <button onClick={() => setTab('all')} className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium ${tab === 'all' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]'}`}>All</button>
        <button onClick={() => setTab('review')} className={`rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium ${tab === 'review' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]'}`}>
          Needs Review {reviewMessages && reviewMessages.length > 0 ? `(${reviewMessages.length})` : ''}
        </button>
      </div>

      {isLoading && <div className="h-32 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-elevated)]" />}
      {!isLoading && (!messages || messages.length === 0) && (
        <EmptyState icon={MessageSquare} title={tab === 'review' ? 'No messages to review' : 'No messages yet'} description={tab === 'review' ? 'All messages have been classified.' : 'Messages appear when customers contact you on WhatsApp.'} />
      )}

      {!isLoading && messages && messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((msg) => (
            <div key={msg.id} className={`rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 ${msg.requiresReview ? 'border-l-4 border-l-[var(--color-warning)]' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {msg.customer?.name ?? msg.customer?.waNumber ?? 'Unknown'}
                  </span>
                  <span className={`text-xs font-semibold uppercase ${intentColor[msg.intent] ?? 'text-[var(--color-text-muted)]'}`}>{msg.intent}</span>
                  {msg.requiresReview && <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-warning)]" />}
                </div>
                <span className="text-xs text-[var(--color-text-muted)]">{timeAgo(msg.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{msg.body ?? '(no text)'}</p>
              {msg.intentConfidence && (
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">Confidence: {Math.round(msg.intentConfidence * 100)}%</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
