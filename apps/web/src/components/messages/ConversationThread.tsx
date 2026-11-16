import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Thread, ThreadMessage } from '@/hooks/useConversations';
import { useSendReply, useDismissDraft } from '@/hooks/useMessages';
import { apiFetch, apiFetchBlob } from '@/lib/api';
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
  const [older, setOlder] = useState<Thread[]>([]);
  const next = older.length ? older[0]?.nextBefore : thread.nextBefore;
  const history = useMutation({
    mutationFn: (before: string) => apiFetch<Thread>(`/conversations/${encodeURIComponent(thread.customer.id)}?before=${encodeURIComponent(before)}`),
    onSuccess: (page) => setOlder((previous) => [page, ...previous]),
  });
  const days = useMemo(() => groupByDay([...new Map([...older.flatMap((page) => page.messages), ...thread.messages]
    .map((message) => [message.id, message])).values()]), [older, thread.messages]);

  // Open at the newest message, the way every messaging app does. Without this
  // a long thread opens on messages from weeks ago.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.customer.id]);

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
      <CustomerWork customerId={thread.customer.id} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {next && <Button variant="ghost" size="sm" className="mb-3" disabled={history.isPending}
          onClick={() => history.mutate(next)}>{history.isPending ? 'Loading history…' : 'Load earlier messages'}</Button>}
        {history.isError && <p role="alert" className="mb-3 text-sm text-danger">Earlier messages could not load. Try again.</p>}
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

const deliveryLabels: Record<string, string> = {
  AUTHORIZED: 'Accepted by Flowdesk',
  QUEUED: 'Queued',
  SENDING: 'Sending',
  PROVIDER_ACCEPTED: 'Accepted by WhatsApp',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Delivery failed',
  RETRY_PENDING: 'Waiting to retry',
  REVIEW_REQUIRED: 'Delivery needs review',
};

function CustomerWork({ customerId }: { customerId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const context = useQuery({ queryKey: ['conversations', 'context', customerId], enabled: open,
    queryFn: () => apiFetch<{
      orders: { id: string; referenceNumber: string; status: string }[];
      visits: { appointmentId: string; state: string; appointment: { reference: string } }[];
      invoices: { id: string; reference: string }[];
    }>('/conversations/' + encodeURIComponent(customerId) + '/context') });
  const rows = context.data && [
    ...context.data.orders.map((item) => ({ ref: item.referenceNumber, status: item.status, href: '/orders?order=' + encodeURIComponent(item.id) })),
    ...context.data.visits.map((item) => ({ ref: item.appointment.reference, status: item.state,
      href: '/bookings?view=operations&visit=' + encodeURIComponent(item.appointmentId) })),
    ...context.data.invoices.map((item) => ({ ref: item.reference, status: '', href: '/payments?view=invoices&invoice=' + encodeURIComponent(item.id) })),
  ];
  return <details className="max-h-40 overflow-y-auto border-b border-border px-4 py-2 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="min-h-8 cursor-pointer font-medium">Customer orders, bookings and invoices</summary>
    {open && context.isPending && <p role="status">Loading linked work…</p>}
    {context.isError && <p role="alert">Linked work could not load. <button className="underline" onClick={() => void context.refetch()}>Try again</button></p>}
    {rows?.length === 0 && <p>No linked work.</p>}
    {rows && <ul className="grid gap-1">{rows.map((record) => <li key={record.href}>
      <Link to={record.href} className="inline-flex min-h-8 items-center gap-2 text-primary underline">
        {record.ref}{record.status && ' · ' + record.status.toLowerCase().replaceAll('_', ' ')}
      </Link>
    </li>)}</ul>}
  </details>;
}

function Attachment({ id }: { id: string }): React.JSX.Element {
  const download = useMutation({ mutationFn: () => apiFetchBlob('/messages/' + encodeURIComponent(id) + '/media'),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
        'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'text/plain': 'txt' }[blob.type] ?? 'bin';
      link.download = 'message-attachment.' + extension;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } });
  return <><Button size="sm" variant="secondary" isLoading={download.isPending} onClick={() => download.mutate()}>Download attachment</Button>
    {download.isError && <p role="alert" className="text-sm">This attachment could not be downloaded.</p>}</>;
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
        {message.hasAttachment && <div className="mt-2"><Attachment id={message.id} /></div>}
      </div>
      <p className="mt-0.5 px-1 text-2xs text-text-muted">
        {formatTime(message.createdAt)}
        {attribution && <span> — {attribution}</span>}
        {message.deliveryState && <span> · {deliveryLabels[message.deliveryState]}</span>}
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
  const dismiss = useDismissDraft();

  // A reply attaches to the customer's most recent message. With none there is
  // nothing to reply to — WhatsApp will not let a shop open a conversation with
  // free text, only answer one.
  const lastInbound = [...thread.messages].reverse().find((m) => !m.fromShop) ?? null;
  const windowClosed =
    lastInbound !== null &&
    Date.now() - new Date(lastInbound.createdAt).getTime() > REPLY_WINDOW_MS;

  // Leave typed text intact while the conversation refreshes.
  const draft = lastInbound?.draft ?? '';
  const { reset } = send;
  useEffect(() => {
    setBody('');
    reset();
  }, [thread.customer.id, reset]);

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
    if (!text || send.isPending || windowClosed) return;
    send.mutate({ id: target.id, body: text, source: text === draft ? 'assistant_draft' : draft ? 'human_takeover' : 'human' },
      { onSuccess: () => setBody('') });
  }

  return (
    <div className="border-t border-border px-4 py-3">
      {draft && <details className="mb-3 max-h-36 overflow-y-auto rounded-md border border-border p-2">
        <summary className="min-h-8 cursor-pointer text-sm font-medium">Assistant draft awaiting review</summary>
        <p className="whitespace-pre-wrap break-words py-2 text-sm">{draft}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={send.isPending || dismiss.isPending || windowClosed}
            onClick={() => send.mutate({ id: target.id, body: draft, source: 'assistant_draft' })}>Approve and send</Button>
          <Button size="sm" variant="secondary" disabled={send.isPending || dismiss.isPending}
            onClick={() => dismiss.mutate({ id: target.id })}>Discard draft</Button>
          <Button size="sm" variant="ghost" onClick={() => setBody(draft)}>Edit as team reply</Button>
        </div>
      </details>}
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
        <Button type="submit" disabled={!body.trim() || send.isPending || windowClosed}>
          {send.isPending ? 'Sending…' : draft ? 'Replace draft' : 'Send'}
        </Button>
      </form>
      {(send.error || dismiss.error) && <p role="alert" className="mt-2 text-xs text-danger">{send.error?.message ?? dismiss.error?.message}</p>}
      {send.isSuccess && <p role="status" className="mt-2 text-xs text-text-secondary">Reply accepted for sending.</p>}
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
