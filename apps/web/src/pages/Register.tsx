import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@flowdesk/shared';
import { useRegister, isAuthenticated } from '@/hooks/useAuth';
import AuthShell, { AuthField, AuthSubmit, AuthError } from '@/components/auth/AuthShell';



export default function RegisterPage(): React.JSX.Element {
  const navigate = useNavigate();
  const register = useRegister();

  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  const serverError = register.error instanceof Error ? register.error.message : null;
  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    // Checked here as well as on the server so the user gets feedback without a
    // round trip; the server remains the authority.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setLocalError(null);

    register.mutate(
      {
        businessName: businessName.trim(),
        ownerName: ownerName.trim(),
        email: email.trim(),
        password,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      {
        // Straight to settings: connecting the WhatsApp number is the next
        // step, and it is what makes the product do anything at all.
        onSuccess: () => navigate('/settings?connect=whatsapp', { replace: true }),
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
          onChange={setBusinessName}
          placeholder="Adom Provisions"
          required
        />

        <AuthField
          id="ownerName"
          label="Your name"
          type="text"
          autoComplete="name"
          value={ownerName}
          onChange={setOwnerName}
          placeholder="Nana Adjoa Mensah"
          required
        />

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

        <AuthField
          id="phone"
          label="Phone number"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={setPhone}
          placeholder="024 418 7702"
          hint="Optional. For account recovery."
        />

        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          required
          hint={`${MIN_PASSWORD_LENGTH} characters or more.`}
          // Surfaced against the field itself rather than only in the banner
          // after a failed submit, so it can be fixed before pressing anything.
          error={passwordTooShort ? `${MIN_PASSWORD_LENGTH - password.length} more to go.` : undefined}
        />

        <AuthError message={localError ?? serverError} />

        <AuthSubmit disabled={register.isPending} isLoading={register.isPending}>
          {register.isPending ? 'Creating your account' : 'Create account'}
        </AuthSubmit>

        <p className="mt-4 text-xs leading-relaxed text-text-muted">
          Next: connect your WhatsApp number. About two minutes.
        </p>
      </form>
    </AuthShell>
  );
}
