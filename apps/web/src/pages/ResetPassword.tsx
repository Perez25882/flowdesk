import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@flowdesk/shared';
import { useResetPassword } from '@/hooks/useAuth';
import AuthShell, {
  AuthField,
  AuthSubmit,
  AuthError,
  AuthNotice,
} from '@/components/auth/AuthShell';



export default function ResetPasswordPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const reset = useResetPassword();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const serverError = reset.error instanceof Error ? reset.error.message : null;

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
    reset.mutate(
      { token, password },
      { onSuccess: () => setTimeout(() => navigate('/login', { replace: true }), 1500) },
    );
  }

  if (!token) {
    return (
      <AuthShell title="Reset link is incomplete" subtitle="This link is missing its token.">
        <AuthError message="Open the link from your email again, or request a new one." />
        <Link
          to="/forgot-password"
          className="inline-block text-sm font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
        >
          Request a new reset link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="You will sign in again with this password.">
      {reset.isSuccess ? (
        <AuthNotice message="Password updated. Taking you to sign in…" />
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <AuthField
            id="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            required
            hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />

          <AuthField
            id="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            required
          />

          <AuthError message={localError ?? serverError} />

          <AuthSubmit disabled={reset.isPending} isLoading={reset.isPending}>
            {reset.isPending ? 'Updating' : 'Update password'}
          </AuthSubmit>
        </form>
      )}
    </AuthShell>
  );
}
