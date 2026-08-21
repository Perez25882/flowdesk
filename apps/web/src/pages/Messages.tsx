import { IntentType } from '@flowdesk/shared';
import { useMemo, useState } from 'react';
import { CheckCircle2, MessageSquare } from 'lucide-react';
import { useMessages, useCorrectMessageIntent } from '@/hooks/useMessages';
import ReplyEditor from '@/components/messages/ReplyEditor';
import EmptyState from '@/components/shared/EmptyState';
import PageHeader from '@/components/shared/PageHeader';
import SearchInput from '@/components/ui/SearchInput';
import { Panel } from '@/components/ui/Panel';
import { Tabs, type TabOption } from '@/components/ui/Tabs';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { useTabParam } from '@/hooks/useTabParam';
import { timeAgo, cn, customerLabel } from '@/lib/utils';

type MessageTab = 'all' | 'review';
const MESSAGE_TABS = ['all', 'review'] as const;

/**
 * Exactly the intents the classifier can hold — no more, no fewer.
 *
 * This list used to offer "A cancellation" and "Thanks", neither of which is a
 * member of `IntentType`. Picking either sent a value Prisma refused, and the
 * resulting validation error is not a `PrismaClientKnownRequestError`, so it
 * fell through to the generic handler and the owner was shown "Internal server
 * error" for doing exactly what the page invited them to do. `STATUS_CHECK` is
 * a real intent and was missing, so a message the assistant misread as an order
 * could not be corrected to it at all.
 */
const INTENT_OPTIONS: { value: `${IntentType}`; label: string }[] = [
  { value: 'ORDER', label: 'An order' },
  { value: 'INQUIRY', label: 'A question' },
  { value: 'PAYMENT', label: 'A payment' },
  { value: 'STATUS_CHECK', label: 'Asking about an order' },
  { value: 'COMPLAINT', label: 'A complaint' },
  { value: 'GREETING', label: 'A greeting' },
  { value: 'OTHER', label: 'Something else' },
  { value: 'UNCLASSIFIED', label: 'Cannot tell' },
];

const INTENT_TONE: Record<string, BadgeTone> = {
  ORDER: 'success',
  PAYMENT: 'info',
  COMPLAINT: 'danger',
  CANCEL: 'danger',
  INQUIRY: 'neutral',
  GREETING: 'neutral',
  THANKS: 'neutral',
  OTHER: 'neutral',
  UNCLASSIFIED: 'warning',
};

const INTENT_LABEL: Record<string, string> = {
  ORDER: 'Order',
  INQUIRY: 'Question',
  PAYMENT: 'Payment',
  COMPLAINT: 'Complaint',
  CANCEL: 'Cancellation',
  GREETING: 'Greeting',
  THANKS: 'Thanks',
  OTHER: 'Other',
  UNCLASSIFIED: 'Unclear',
};

/**
 * The review queue.
 *
 * This screen exists because Flowdesk sometimes cannot tell what a message
 * meant, and the correction the owner makes here is training data. The
 * previous version presented that as a bare dropdown labelled "Correct intent"
 * listing nine engineering enum names.
 *
 * Now the question is asked in words a shop owner uses — "What was this
 * message actually about?" — and the options are phrases, not enum labels. The
 * confidence score is spelled out too, since "62% conf" means nothing to
 * someone who has never seen a classifier.
 */
export default function MessagesPage(): React.JSX.Element {
  const [tab, setTab] = useTabParam<MessageTab>('view', MESSAGE_TABS, 'all');
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

  const tabOptions: readonly TabOption<MessageTab>[] = [
    { value: 'all', label: 'All messages' },
    { value: 'review', label: 'Needs you', count: reviewMessages?.length ?? 0 },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Messages"
        description="What came in, and what needs a decision."
        actions={
          <SearchInput
            label="Search messages by customer, number or text"
            placeholder="Search messages"
            value={search}
            onChange={setSearch}
            className="w-full sm:w-64"
          />
        }
      />

      <div>
        <Tabs label="Filter messages" options={tabOptions} value={tab} onChange={setTab} />

        <div className="mt-4">
          {isLoading && (
            <Panel>
              <SkeletonRows count={5} />
            </Panel>
          )}

          {!isLoading && filtered.length === 0 && (
            <Panel>
              <EmptyState
                icon={MessageSquare}
                title={search ? 'No matches' : tab === 'review' ? 'Nothing needs you' : 'No messages yet'}
                description={
                  search
                    ? 'Try a name, a number, or a word from the message.'
                    : tab === 'review'
                      ? 'Flowdesk understood every message.'
                      : 'Messages appear as customers write to you.'
                }
              />
            </Panel>
          )}

          {!isLoading && filtered.length > 0 && (
            <ul className="space-y-2.5">
              {filtered.map((msg) => {
                const isPending = correctIntent.isPending && correctIntent.variables?.id === msg.id;
                const justSaved =
                  correctIntent.isSuccess && correctIntent.variables?.id === msg.id;
                const failed = correctIntent.isError && correctIntent.variables?.id === msg.id;
                const displayName = customerLabel(msg.customer);

                return (
                  <li
                    key={msg.id}
                    className={cn(
                      'relative overflow-hidden rounded-lg border border-border bg-surface',
                      // A rule on the leading edge, so a flagged message is
                      // findable while scanning without tinting the whole card.
                      msg.requiresReview && 'border-warning-border',
                    )}
                  >
                    {msg.requiresReview && (
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
                    )}

                    <div className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-text-primary">
                            {displayName}
                          </span>
                          <Badge tone={INTENT_TONE[msg.intent] ?? 'neutral'}>
                            {INTENT_LABEL[msg.intent] ?? msg.intent}
                          </Badge>
                          {typeof msg.intentConfidence === 'number' && (
                            <span className="text-2xs text-text-muted">
                              {Math.round(msg.intentConfidence * 100)}% sure
                            </span>
                          )}
                        </span>

                        <span className="text-xs text-text-muted">{timeAgo(msg.createdAt)}</span>
                      </div>

                      <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-text-secondary">
                        {msg.body ?? 'This message had no text in it.'}
                      </p>

                      {msg.requiresReview && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
                          <label
                            htmlFor={`intent-${msg.id}`}
                            className="text-xs font-medium text-text-primary"
                          >
                            What was this actually about?
                          </label>

                          <select
                            id={`intent-${msg.id}`}
                            disabled={isPending}
                            defaultValue=""
                            onChange={(e) => {
                              const intent = e.target.value;
                              if (!intent) return;
                              correctIntent.mutate({ id: msg.id, intent });
                              e.target.value = '';
                            }}
                            className="fd-input fd-select fd-input-compact h-9 w-auto py-0"
                          >
                            <option value="" disabled>
                              Choose
                            </option>
                            {INTENT_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>

                          {justSaved && (
                            <span
                              role="status"
                              className="inline-flex items-center gap-1 text-xs font-medium text-success"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                              Saved
                            </span>
                          )}

                          {failed && (
                            <span role="alert" className="text-xs font-medium text-danger">
                              {(correctIntent.error as Error).message}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Inbound only — there is nothing to reply to on a
                          message the business itself sent. */}
                      {msg.direction === 'INBOUND' && <ReplyEditor message={msg} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
