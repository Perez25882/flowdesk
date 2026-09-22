import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@flowdesk/shared';
import { useRegister, isAuthenticated } from '@/hooks/useAuth';
import AuthShell, {
  AuthField,
  AuthSubmit,
  AuthError,
  useFieldErrors,
  splitApiError,
  validateEmailShape,
  type FieldErrors,
} from '@/components/auth/AuthShell';

/** The server's own ceiling, from auth.schema.ts. bcrypt ignores past 72 bytes. */
const MAX_PASSWORD_LENGTH = 72;

type Field = 'businessName' | 'ownerName' | 'email' | 'phone' | 'password';

const FIELDS = ['businessName', 'ownerName', 'email', 'phone', 'password'] as const;
const ORDER: Field[] = ['businessName', 'ownerName', 'email', 'phone', 'password'];

export default function RegisterPage(): React.JSX.Element {
  const navigate = useNavigate();
  const register = useRegister();

  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  // `RefObject<HTMLInputElement>`, not `RefObject<HTMLInputElement | null>`.
  // The second is the React 19 spelling and does not assign to a DOM `ref` prop
  // on React 18's types; it was overriding what `useRef<HTMLInputElement>(null)`
  // already returns. This shape keeps `.current` for the focus call below while
  // still being something the input can accept.
  const refs: Record<Field, React.RefObject<HTMLInputElement>> = {
    businessName: useRef<HTMLInputElement>(null),
    ownerName: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const busy = register.isPending;
  const serverMessage = register.error instanceof Error ? register.error.message : null;

  const validate = useMemo(
    () =>
      (field: Field, value: string): string | undefined => {
        const trimmed = value.trim();
        switch (field) {
          case 'businessName':
            return trimmed === '' ? 'What is the business called?' : undefined;
          case 'ownerName':
            return trimmed === '' ? 'Enter your name.' : undefined;
          case 'email':
            return validateEmailShape(value);
          case 'phone':
            // Genuinely optional, so an empty value is never wrong.
            return undefined;
          case 'password':
            if (value.length < MIN_PASSWORD_LENGTH) {
              return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
            }
            if (value.length > MAX_PASSWORD_LENGTH) {
              return `Keep it under ${MAX_PASSWORD_LENGTH} characters.`;
            }
            return undefined;
          default:
            return undefined;
        }
      },
    [],
  );

  const { errors, handleBlur, handleChange, setErrors } = useFieldErrors<Field>(validate);

  // A 409 on this form means the email is taken, which is a fact about the
  // email box and belongs under it rather than in a banner above the form.
  const split = splitApiError<Field>(serverMessage, FIELDS);
  const emailTaken = /already exists|already registered|taken/i.test(serverMessage ?? '');
  const shown: FieldErrors<Field> = {
    ...errors,
    ...split.fieldErrors,
    ...(emailTaken
      ? { email: 'An account with this email already exists. Sign in instead?' }
      : {}),
  };

  /**
   * How far off the minimum the password is, while it is being typed.
   *
   * Shown as a hint, not as an error. Red text under a field someone is
   * halfway through filling reads as a rejection of what they have typed,
   * when it is really just a progress count. It only becomes an error once
   * they leave the field short, which `useFieldErrors` handles.
   */
  const remaining = MIN_PASSWORD_LENGTH - password.length;
  const passwordHint =
    password.length === 0
      ? `${MIN_PASSWORD_LENGTH} characters or more. Nothing else required.`
      : remaining > 0
        ? `${remaining} more to go.`
        : 'Long enough.';

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;

    const values: Record<Field, string> = { businessName, ownerName, email, phone, password };
    const next: FieldErrors<Field> = {};
    for (const field of ORDER) {
      next[field] = validate(field, values[field]);
    }

    if (ORDER.some((field) => next[field])) {
      setErrors(next);
      const first = ORDER.find((field) => next[field]);
      if (first) refs[first].current?.focus();
      return;
    }

    register.mutate(
      {
        businessName: businessName.trim(),
        ownerName: ownerName.trim(),
        email: email.trim(),
        password,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      {
        // Verify first, skippable. Connecting the WhatsApp number is still the
        // step that makes the product do anything, and the verification page
        // hands straight over to it either way.
        onSuccess: () => navigate('/verify-email', { replace: true }),
      },
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="14 days free. No card."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            className="font-semibold text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <AuthField
          id="businessName"
          label="Business name"
          type="text"
          autoComplete="organization"
          value={businessName}
          onChange={(value) => {
            setBusinessName(value);
            handleChange('businessName', value);
          }}
          onBlur={() => handleBlur('businessName', businessName)}
          inputRef={refs.businessName}
          error={shown.businessName}
          placeholder="Adom Provisions"
          required
        />

        <AuthField
          id="ownerName"
          label="Your name"
          type="text"
          autoComplete="name"
          value={ownerName}
          onChange={(value) => {
            setOwnerName(value);
            handleChange('ownerName', value);
          }}
          onBlur={() => handleBlur('ownerName', ownerName)}
          inputRef={refs.ownerName}
          error={shown.ownerName}
          placeholder="Nana Adjoa Mensah"
          required
        />

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
          inputRef={refs.email}
          error={shown.email}
          placeholder="you@yourbusiness.com"
          required
        />

        <AuthField
          id="phone"
          label="Phone number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={setPhone}
          inputRef={refs.phone}
          placeholder="024 418 7702"
          hint="Optional. For account recovery."
        />

        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            handleChange('password', value);
          }}
          onBlur={() => handleBlur('password', password)}
          inputRef={refs.password}
          error={shown.password}
          hint={passwordHint}
          required
        />

        <AuthError message={emailTaken ? null : split.formError} />

        <AuthSubmit disabled={busy} isLoading={busy}>
          {busy ? 'Creating your account' : 'Create account'}
        </AuthSubmit>

        <p className="mt-4 text-xs leading-relaxed text-text-muted">
          Next: connect your WhatsApp number. About two minutes.
        </p>
      </form>
    </AuthShell>
  );
}
