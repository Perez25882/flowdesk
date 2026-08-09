import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useForgotPassword } from '@/hooks/useAuth';
import AuthShell, {
  AuthField,
  AuthSubmit,
  AuthError,
  AuthNotice,
} from '@/components/auth/AuthShell';

export default function ForgotPasswordPage(): React.JSX.Element {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');

  const error = forgot.error instanceof Error ? forgot.error.message : null;
  const result = forgot.data;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    forgot.mutate({ email: email.trim() });
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
    >
      {result ? (
        <>
          <AuthNotice message={result.message} />

          {/*
            Without an email provider configured the link cannot be delivered,
            so the API returns the token directly in development. This branch
            never renders in production, where email is required at boot.
          */}
          {result.resetToken && (
            <div className="mb-4 rounded-lg border border-border bg-surface-sunken p-3">
              <p className="mb-2 text-xs text-text-secondary">
                Email is not configured on this server, so here is the link:
              </p>
              <Link
                to={`/reset-password?token=${encodeURIComponent(result.resetToken)}`}
                className="break-all text-xs font-medium text-primary"
              >
                Continue to reset your password
              </Link>
            </div>
          )}

          <Link
            to="/login"
            className="inline-block text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
          >
            Back to sign in
          </Link>
        </>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <AuthField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            placeholder="you@business.com"
            required
          />

          <AuthError message={error} />

          <AuthSubmit disabled={forgot.isPending} isLoading={forgot.isPending}>
            {forgot.isPending ? 'Sending' : 'Send reset link'}
          </AuthSubmit>

          <p className="mt-6 text-sm text-text-secondary">
            Remembered it?{' '}
            <Link to="/login" className="font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
