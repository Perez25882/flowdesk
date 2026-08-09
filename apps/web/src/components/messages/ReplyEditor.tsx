import { useState } from 'react';
import { Send, Sparkles, X } from 'lucide-react';
import { useDismissDraft, useSendReply, type Message } from '@/hooks/useMessages';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * Reply to a customer, inline under their message.
 *
 * Where the assistant wrote something, it is loaded into the box as editable
 * text rather than as a fixed suggestion with a Send button beside it. An owner
 * who can only accept or reject has to leave for WhatsApp to fix one word, and
 * the edits they make here are the clearest signal of whether the assistant can
 * be trusted to send on its own.
 */

interface Props {
  message: Message;
}

const SENT_STATUSES = new Set(['SENT', 'AUTO_SENT']);

export default function ReplyEditor({ message }: Props): React.JSX.Element | null {
  const suggestion = message.aiReplyText;
  const status = message.aiReplyStatus;

  const [body, setBody] = useState(suggestion ?? '');
  const [open, setOpen] = useState(status === 'DRAFT');

  const send = useSendReply();
  const dismiss = useDismissDraft();

  // Nothing to reply to.
  if (!message.customer) return null;

  if (status && SENT_STATUSES.has(status)) {
    return (
      <p className="mt-2 text-xs text-text-muted">
        {status === 'AUTO_SENT' ? 'Answered automatically.' : 'Replied.'}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 rounded-sm text-xs font-semibold text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Reply
      </button>
    );
  }

  const failed = message.aiValidationFailed ?? [];
  const isDraft = status === 'DRAFT';
  const changed = suggestion !== null && body !== suggestion;

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
      {isDraft && (
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
          Suggested reply
          {changed && <span className="font-normal text-text-muted">· edited</span>}
        </p>
      )}

      {failed.length > 0 && (
        <p className="mb-2 rounded-sm border border-warning-border bg-warning-muted px-2 py-1.5 text-xs text-text-primary">
          Worth checking before you send — the assistant could not verify:{' '}
          {failed.join(', ')}.
        </p>
      )}

      <textarea
        aria-label="Your reply"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a reply…"
        className={cn(
          'w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary',
          'placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        )}
      />

      {send.isError && (
        <p className="mt-2 text-xs text-danger">{send.error.message}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={body.trim().length === 0 || send.isPending}
          onClick={() => send.mutate({ id: message.id, body: body.trim() })}
          leadingIcon={<Send className="h-3.5 w-3.5" strokeWidth={1.75} />}
        >
          {send.isPending ? 'Sending' : 'Send'}
        </Button>

        {isDraft ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate({ id: message.id })}
            leadingIcon={<X className="h-3.5 w-3.5" strokeWidth={1.75} />}
          >
            Discard
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}

        {changed && suggestion !== null && (
          <button
            type="button"
            onClick={() => setBody(suggestion)}
            className="rounded-sm px-1.5 py-px text-2xs font-semibold text-text-secondary underline decoration-border-strong underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Undo edits
          </button>
        )}
      </div>
    </div>
  );
}
