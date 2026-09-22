import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirmEmailCode, useRequestEmailCode } from '@/hooks/useEmailVerification';
import AuthShell, { AuthError, AuthField, AuthNotice, AuthSubmit } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';

const NEXT = '/settings?connect=whatsapp';

/**
 * Confirm the email address, with a code.
 *
 * Skippable, deliberately. The thing a new owner is here to do is connect their
 * WhatsApp number, and a shop that cannot be set up until an email arrives is a
 * shop that does not get set up. Verification protects the account rather than
 * gating the product, so it asks rather than blocks, and the account stays
 * usable either way.
 */
export default function VerifyEmailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const request = useRequestEmailCode();
  const confirm = useConfirmEmailCode();

  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const asked = useRef(false);

  // One automatic send on arrival. The guard survives React's double-invoked
  // effects in development, which would otherwise burn the resend cooldown
  // before the page had finished painting.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    request.mutate();
  }, [request]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (confirm.isPending) return;

    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setLocalError('Enter the six digit code from your email.');
      codeRef.current?.focus();
      return;
    }

    setLocalError(null);
    confirm.mutate(digits, { onSuccess: () => navigate(NEXT, { replace: true }) });
  }

  const serverError = confirm.error instanceof Error ? confirm.error.message : null;
  const requestError = request.error instanceof Error ? request.error.message : null;

  // A local run with no email provider logs the code instead of sending it.
  // Saying so beats letting someone wait for mail that was never posted.
  const notDelivered = request.data?.delivered === false;

  return (
    <AuthShell
      title="Check your email"
      subtitle="We sent you a six digit code. It is good for ten minutes."
      footer={
        <button
          type="button"
          onClick={() => navigate(NEXT, { replace: true })}
          className="font-semibold text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
        >
          Skip for now
        </button>
      }
    >
      {notDelivered && (
        <AuthNotice message="Email is not configured on this deployment, so the code was written to the server log instead of sent." />
      )}

      <form onSubmit={handleSubmit} noValidate>
        <AuthField
          id="code"
          label="Code"
          type="text"
          inputMode="numeric"
          // One-time-code autofill: on iOS and Android this offers the code
          // straight from the notification, which removes the app switch that
          // loses most people.
          autoComplete="one-time-code"
          value={code}
          onChange={(value) => {
            setCode(value);
            if (localError) setLocalError(null);
          }}
          inputRef={codeRef}
          error={localError ?? serverError ?? undefined}
          placeholder="123456"
          required
        />

        <AuthError message={requestError} />

        <AuthSubmit disabled={confirm.isPending} isLoading={confirm.isPending}>
          {confirm.isPending ? 'Checking' : 'Verify'}
        </AuthSubmit>

        <div className="mt-4">
          <Button
            variant="link"
            type="button"
            onClick={() => request.mutate()}
            disabled={request.isPending}
          >
            {request.isPending ? 'Sending' : 'Send another code'}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
