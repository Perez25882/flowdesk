import { useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useAcceptAutonomy } from '@/hooks/useBusiness';
import { Button } from '@/components/ui/Button';

/**
 * The gate in front of autonomous mode.
 *
 * Deliberately not a checkbox in a settings row. The owner is about to let
 * software handle eligible replies and payment requests. The confirmation
 * makes that permission explicit.
 *
 * The wording here is a summary shown on screen; the exact text recorded
 * against the account is the server's, so an edit to this component cannot
 * change what anyone is held to have accepted.
 */
const CONFIRM_WORD = 'I UNDERSTAND';

export default function AutonomyConsent({
  accepted,
  onAccepted,
}: {
  accepted: boolean;
  onAccepted: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const accept = useAcceptAutonomy();

  if (accepted) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-hover p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" strokeWidth={2} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary">You have accepted autonomous replies.</p>
          <p className="mt-0.5 text-xs text-text-muted">
            Turning the mode off does not withdraw this. Use the button if you want it
            withdrawn as well.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => accept.mutate(false, { onSuccess: onAccepted })}
          isLoading={accept.isPending}
        >
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={2} aria-hidden="true" />
        Before you turn this on
      </p>

      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-text-secondary">
        <li>
          Replies go to your customers from your number with nobody reading them first.
        </li>
        <li>
          Prices, availability and other material commitments are checked against your business records. Requests that need a person go to your team.
        </li>
        <li>It can take eligible orders and send payment links for verified balances.</li>
        <li>
          Anything it sends is yours to honour with your customer. They have no agreement
          with Flowdesk.
        </li>
      </ul>

      <p className="text-xs text-text-muted">
        The inbox records replies and requests that need review.
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-primary">
          Type <span className="fd-figure">{CONFIRM_WORD}</span> to continue
        </span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </label>

      <div>
        <Button
          onClick={() => accept.mutate(true, { onSuccess: onAccepted })}
          disabled={typed.trim().toUpperCase() !== CONFIRM_WORD}
          isLoading={accept.isPending}
        >
          Accept and enable
        </Button>
      </div>

      {accept.isError && (
        <p role="alert" className="text-sm text-danger">
          {accept.error.message}
        </p>
      )}
    </div>
  );
}
