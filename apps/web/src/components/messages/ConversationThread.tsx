import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { Thread, ThreadMessage } from '@/hooks/useConversations';
import { useSendReply } from '@/hooks/useMessages';
import { Button } from '@/components/ui/Button';
import { cn, customerLabel, formatPhone } from '@/lib/utils';

/**
 * One customer's conversation, read top to bottom.
 *
 * The question this pane exists to answer is the one an owner has after
 * handing their WhatsApp to an assistant: what was said to this customer on my
 * behalf, and does anything still need me? So the shop's side is set apart
 * from the customer's by position and colour, the messages still waiting are
 * marked where they sit, and who sent a reply is stated only where it is
 * actually recorded — a guess would put a person's words in the machine's
 * mouth or the reverse.
 */
export default function ConversationThread({
  thread,
  onBack,
}: {
  thread: Thread;
  onBack: () => void;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => groupByDay(thread.messages), [thread.messages]);

  // Open at the newest message, the way every messaging app does. Without this
  // a long thread opens on messages from weeks ago.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.customer.id, thread.messages.length]);

  const label = customerLabel(thread.customer);
  const phone = formatPhone(thread.customer.waNumber);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 rounded-md p-1 text-text-secondary hover:bg-surface-hover lg:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{label}</p>
          {label !== phone && <p className="fd-figure text-2xs text-text-muted">{phone}</p>}
        </div>
        <Link
          to={`/customers/${thread.customer.id}`}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          Customer profile
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {days.map((day) => (
          <section key={day.key} aria-label={day.label} className="mb-4">
            <p className="mb-3 text-center text-2xs font-medium text-text-muted">{day.label}</p>
            <ol className="flex flex-col gap-1.5">
              {day.messages.map((message) => (
                <li key={message.id}>
                  <Bubble message={message} />
                </li>
              ))}
            </ol>
          </section>
        ))}
        <div ref={endRef} />
      </div>

      <Composer thread={thread} />
    </div>
  );
}

function Bubble({ message }: { message: ThreadMessage }): React.JSX.Element {
  const body = message.body?.trim() || (message.type === 'IMAGE' ? 'Photo' : 'Attachment');
  const attribution =
    message.sentBy === 'phone' ? 'From your phone' : message.sentBy === 'staff' ? 'By staff' : null;

  return (
    <div className={cn('flex flex-col', message.fromShop ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          message.fromShop
            ? 'rounded-br-md bg-primary text-white'
            : 'rounded-bl-md bg-surface-hover text-text-primary',
          message.needsYou && 'ring-2 ring-accent/60',
        )}
      >
        {body}
      </div>
      <p className="mt-0.5 px-1 text-2xs text-text-muted">
        {formatTime(message.createdAt)}
        {attribution && <span> — {attribution}</span>}
        {message.needsYou && <span className="font-semibold text-accent"> — Needs a reply</span>}
      </p>
    </div>
  );
}

/** WhatsApp allows a free-form reply only within 24 hours of the customer's last message. */
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function Composer({ thread }: { thread: Thread }): React.JSX.Element {
  const [body, setBody] = useState('');
  const send = useSendReply();

  // A reply attaches to the customer's most recent message. With none there is
  // nothing to reply to — WhatsApp will not let a shop open a conversation with
  // free text, only answer one.
  const lastInbound = [...thread.messages].reverse().find((m) => !m.fromShop) ?? null;
  const windowClosed =
    lastInbound !== null &&
    Date.now() - new Date(lastInbound.createdAt).getTime() > REPLY_WINDOW_MS;

  // Opening a thread offers the assistant's suggestion, when there is one, so a
  // DRAFT_ONLY shop approves a reply in one tap instead of retyping it. It is
  // put in the box rather than sent, and the owner can change every word.
  //
  // Keyed on the customer AND the draft: switching threads must not carry one
  // customer's unsent text into another's, and a new suggestion arriving for
  // the open thread should replace a stale one.
  const draft = lastInbound?.draft ?? '';
  const { reset } = send;
  useEffect(() => {
    setBody(draft);
    reset();
  }, [thread.customer.id, draft, reset]);

  if (!lastInbound) {
    return (
      <p className="border-t border-border px-4 py-3 text-xs text-text-muted">
        This customer hasn&apos;t messaged you, so there&apos;s nothing to reply to yet.
      </p>
    );
  }

  const target = lastInbound;

  function submit(): void {
    const text = body.trim();
    if (!text) return;
    send.mutate({ id: target.id, body: text }, { onSuccess: () => setBody('') });
  }

  return (
    <div className="border-t border-border px-4 py-3">
      {draft && body === draft && (
        <p className="mb-2 text-2xs text-text-muted">
          Suggested by your assistant. Edit it or send it as it is.
        </p>
      )}
      {windowClosed && (
        <p className="mb-2 text-2xs text-text-muted">
          Their last message was over a day ago. WhatsApp only allows approved templates now, so a
          typed reply won&apos;t be delivered.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <label htmlFor="reply" className="sr-only">
          Reply to {customerLabel(thread.customer)}
        </label>
        <textarea
          id="reply"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter breaks the line — the convention of
            // every messaging app an owner already uses.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Write a reply"
          className="fd-input max-h-40 min-h-[40px] flex-1 resize-none"
        />
        <Button type="submit" disabled={!body.trim() || send.isPending}>
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
      {send.error && <p className="mt-2 text-xs text-danger">{send.error.message}</p>}
    </div>
  );
}

interface Day {
  key: string;
  label: string;
  messages: ThreadMessage[];
}

/**
 * Splits the thread at each calendar day.
 *
 * A conversation spanning days reads as one undifferentiated column without
 * these, and "yesterday at 4pm" versus "this morning" is often the whole story
 * of why an order is late.
 */
function groupByDay(messages: ThreadMessage[]): Day[] {
  const days: Day[] = [];
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const key = date.toDateString();
    const current = days[days.length - 1];
    if (current && current.key === key) {
      current.messages.push(message);
    } else {
      days.push({ key, label: dayLabel(date), messages: [message] });
    }
  }
  return days;
}

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
}
