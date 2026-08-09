import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useLogin, useStaffLogin, isAuthenticated } from '@/hooks/useAuth';
import AuthShell, { AuthField, AuthSubmit, AuthError } from '@/components/auth/AuthShell';
import { cn } from '@/lib/utils';

type Mode = 'owner' | 'staff';

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('owner');

  const ownerLogin = useLogin();
  const staffLogin = useStaffLogin();

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const active = mode === 'owner' ? ownerLogin : staffLogin;
  const busy = active.isPending;
  const error = active.error instanceof Error ? active.error.message : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const onSuccess = (): void => navigate('/dashboard', { replace: true });

    if (mode === 'owner') {
      ownerLogin.mutate({ email: email.trim(), password }, { onSuccess });
    } else {
      staffLogin.mutate({ phone: phone.trim(), password }, { onSuccess });
    }
  }

  return (
    <AuthShell
      title="Log in"
      subtitle={
        mode === 'owner'
          ? 'Orders, payments and customers, in one place.'
          : 'Use the number your manager invited.'
      }
      footer={
        mode === 'owner' ? (
          <>
            New to Flowdesk?{' '}
            <Link
              to="/register"
              className="font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
            >
              Create an account
            </Link>
          </>
        ) : undefined
      }
    >
      {/* An underlined segmented control rather than a filled pill. The filled
          version put a solid brand-green block directly above the submit
          button, so two things on a four-element form looked like the action. */}
      <div
        role="tablist"
        aria-label="Account type"
        className="mb-6 flex gap-1 border-b border-border"
      >
        {(['owner', 'staff'] as const).map((option) => (
          <button
            key={option}
            role="tab"
            type="button"
            aria-selected={mode === option}
            onClick={() => setMode(option)}
            className={cn(
              'relative px-3 pb-2.5 text-sm font-medium transition-colors duration-fast ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              mode === option ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {option === 'owner' ? 'Business owner' : 'Staff member'}
            <span
              aria-hidden="true"
              className={cn(
                'absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-opacity duration-fast ease-out',
                mode === option ? 'bg-primary opacity-100' : 'opacity-0',
              )}
            />
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} noValidate>
        {mode === 'owner' ? (
          <AuthField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            placeholder="you@yourbusiness.com"
            required
          />
        ) : (
          <AuthField
            id="phone"
            label="Phone number"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={setPhone}
            placeholder="024 418 7702"
            required
          />
        )}

        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />

        {mode === 'owner' && (
          <div className="mb-4 -mt-1">
            <Link
              to="/forgot-password"
              className="text-sm text-text-secondary underline decoration-border-strong underline-offset-[3px] hover:text-text-primary"
            >
              Forgot your password?
            </Link>
          </div>
        )}

        <AuthError message={error} />

        <AuthSubmit disabled={busy} isLoading={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
