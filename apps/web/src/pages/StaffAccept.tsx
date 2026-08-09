import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@flowdesk/shared';
import { useAcceptStaffInvite } from '@/hooks/useAuth';
import AuthShell, {
  AuthField,
  AuthSubmit,
  AuthError,
  AuthNotice,
} from '@/components/auth/AuthShell';



/**
 * Where an invited staff member sets their password. Reached from the invite
 * link sent by their manager; afterwards they sign in on the Staff tab of the
 * login page using their phone number.
 */
export default function StaffAcceptPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const accept = useAcceptStaffInvite();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const serverError = accept.error instanceof Error ? accept.error.message : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (password.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    if (password !== confirm) {
      setLocalError('The two passwords do not match');
      return;
    }

    setLocalError(null);
    accept.mutate(
      { token, password },
      { onSuccess: () => setTimeout(() => navigate('/login', { replace: true }), 1500) },
    );
  }

  if (!token) {
    return (
      <AuthShell title="Invitation link is incomplete" subtitle="This link is missing its token.">
        <AuthError message="Ask your manager to send the invitation again." />
        <Link
          to="/login"
          className="inline-block text-sm font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
        >
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set up your access"
      subtitle="Choose a password to finish joining the team."
    >
      {accept.isSuccess ? (
        <AuthNotice message="All set. Taking you to sign in…" />
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <AuthField
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            required
            hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />

          <AuthField
            id="confirm"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            required
          />

          <AuthError message={localError ?? serverError} />

          <AuthSubmit disabled={accept.isPending} isLoading={accept.isPending}>
            {accept.isPending ? 'Setting up' : 'Set password'}
          </AuthSubmit>
        </form>
      )}
    </AuthShell>
  );
}
