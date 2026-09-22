import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useLogin, useStaffLogin, isAuthenticated } from '@/hooks/useAuth';
import AuthShell, {
  AuthField,
  AuthSubmit,
  AuthError,
  useFieldErrors,
  splitApiError,
  validateEmailShape,
  type FieldErrors,
} from '@/components/auth/AuthShell';
import { cn } from '@/lib/utils';

type Mode = 'owner' | 'staff';
type Field = 'email' | 'phone' | 'password';

const FIELDS = ['email', 'phone', 'password'] as const;

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('owner');

  const ownerLogin = useLogin();
  const staffLogin = useStaffLogin();

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const active = mode === 'owner' ? ownerLogin : staffLogin;
  const busy = active.isPending;
  const serverMessage = active.error instanceof Error ? active.error.message : null;

  /**
   * Sign-in checks shape, never length.
   *
   * A minimum-length rule here would reject the password of anyone who
   * registered before that rule existed, and it would do so client-side with a
   * message implying they had typed it wrong. Whether the password is right is
   * the server's question, and it is the only one qualified to answer it.
   */
  const validate = useMemo(
    () =>
      (field: Field, value: string): string | undefined => {
        switch (field) {
          case 'email':
            return validateEmailShape(value);
          case 'phone':
            return value.trim() === '' ? 'Enter the number your manager invited.' : undefined;
          case 'password':
            return value === '' ? 'Enter your password.' : undefined;
          default:
            return undefined;
        }
      },
    [],
  );

  const { errors, handleBlur, handleChange, setErrors } = useFieldErrors<Field>(validate);

  // Server-side validation lands on the field it is about; wrong credentials,
  // lockouts and network failures stay form-level, because none of those are
  // about one box.
  const split = splitApiError<Field>(serverMessage, FIELDS);

  const shown: FieldErrors<Field> = { ...errors, ...split.fieldErrors };

  function fail(next: FieldErrors<Field>, order: Field[]): void {
    setErrors(next);
    const first = order.find((field) => next[field]);
    const refs: Record<Field, typeof emailRef> = {
      email: emailRef,
      phone: phoneRef,
      password: passwordRef,
    };
    if (first) refs[first].current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second submit while the first is in flight would fire a second request
    // and, on a rotating refresh token, sign the person straight back out.
    if (busy) return;

    const identifier: Field = mode === 'owner' ? 'email' : 'phone';
    const identifierValue = mode === 'owner' ? email : phone;

    const next: FieldErrors<Field> = {
      [identifier]: validate(identifier, identifierValue),
      password: validate('password', password),
    };

    if (next[identifier] || next.password) {
      fail(next, [identifier, 'password']);
      return;
    }

    const onSuccess = (): void => navigate('/dashboard', { replace: true });

    if (mode === 'owner') {
      ownerLogin.mutate({ email: email.trim(), password }, { onSuccess });
    } else {
      staffLogin.mutate({ phone: phone.trim(), password }, { onSuccess });
    }
  }

  function switchMode(next: Mode): void {
    setMode(next);
    // The other tab's complaints are not about what is on screen now.
    setErrors({});
    active.reset();
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
            onClick={() => switchMode(option)}
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
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              handleChange('email', value);
            }}
            onBlur={() => handleBlur('email', email)}
            inputRef={emailRef}
            error={shown.email}
            placeholder="you@yourbusiness.com"
            required
          />
        ) : (
          <AuthField
            id="phone"
            label="Phone number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(value) => {
              setPhone(value);
              handleChange('phone', value);
            }}
            onBlur={() => handleBlur('phone', phone)}
            inputRef={phoneRef}
            error={shown.phone}
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
          onChange={(value) => {
            setPassword(value);
            handleChange('password', value);
          }}
          onBlur={() => handleBlur('password', password)}
          inputRef={passwordRef}
          error={shown.password}
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

        <AuthError message={split.formError} />

        <AuthSubmit disabled={busy} isLoading={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
