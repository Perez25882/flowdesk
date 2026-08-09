import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import Wordmark from '@/components/marketing/Wordmark';

/**
 * Shared chrome for every unauthenticated screen (sign in, register, password
 * reset, staff invite). Keeping the layout, field styling and error
 * presentation in one place is what stops these screens drifting apart as more
 * are added.
 *
 * The layout is a split rather than a single card floating in the middle of an
 * empty page. Someone about to connect the phone number their business runs on
 * is making a trust decision, and a lone centred box on a blank background is
 * the same thing every side project ships. The right-hand panel carries plain,
 * checkable statements — no logos we do not have, no testimonials we did not
 * receive, no stock photograph of a smiling team.
 */

/** Plain statements, not marketing. Each one is verifiable in the product. */
const ASSURANCES = [
  { head: 'Your existing number', body: 'Customers notice nothing.' },
  { head: 'Nothing sends without you', body: 'Unclear messages wait in a queue.' },
  { head: 'Your data stays yours', body: 'Export or close the account from Settings.' },
];

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Secondary action shown under the form, e.g. a link to sign up. */
  footer?: ReactNode;
}

export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: AuthShellProps): React.JSX.Element {
  return (
    <div className="min-h-[100dvh] bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      {/* ── The form ── */}
      <div className="flex min-h-[100dvh] flex-col px-5 py-6 sm:px-8 lg:min-h-0 lg:px-12 lg:py-10">
        <header className="shrink-0">
          <Link
            to="/"
            className="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Wordmark />
            <span className="sr-only">Flowdesk home</span>
          </Link>
        </header>

        {/* Top-aligned on small screens so the on-screen keyboard cannot push
            the form out of view; centred once there is room. */}
        <main className="flex flex-1 items-start pb-10 pt-10 sm:items-center sm:pt-6">
          <div className="w-full max-w-[380px] lg:mx-auto">
            <h1 className="text-2xl font-extrabold tracking-tighter text-text-primary">{title}</h1>
            <p className="mt-2 text-base text-text-secondary">{subtitle}</p>

            <div className="mt-7">{children}</div>

            {footer && <p className="mt-6 text-sm text-text-secondary">{footer}</p>}
          </div>
        </main>

        <footer className="shrink-0">
          <p className="text-xs text-text-muted">
            &copy; {new Date().getFullYear()} Flowdesk ·{' '}
            <Link to="/privacy" className="hover:text-text-secondary">
              Privacy
            </Link>{' '}
            ·{' '}
            <Link to="/terms" className="hover:text-text-secondary">
              Terms
            </Link>
          </p>
        </footer>
      </div>

      {/* ── The reassurance ── */}
      <aside className="fd-grain relative hidden border-l border-border bg-surface lg:flex lg:flex-col lg:justify-center lg:px-12">
        <div
          aria-hidden="true"
          className="fd-ruled pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(100%_60%_at_100%_50%,#000_10%,transparent_70%)]"
        />

        <div className="relative max-w-sm">
          <p className="fd-label">Before you connect anything</p>

          <dl className="mt-7 divide-y divide-border-subtle border-y border-border-subtle">
            {ASSURANCES.map((item) => (
              <div key={item.head} className="py-5">
                <dt className="text-base font-bold tracking-tight text-text-primary">
                  {item.head}
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-text-secondary">{item.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
    </div>
  );
}

interface AuthFieldProps {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  /** Field-level validation message, announced to assistive tech. */
  error?: string | undefined;
}

export function AuthField({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  required,
  hint,
  error,
}: AuthFieldProps): React.JSX.Element {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>

      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        // Autocorrect on an email or phone field turns a valid address into
        // a red squiggle and, on iOS, sometimes into a different address.
        spellCheck={type === "email" || type === "tel" || type === "password" ? false : undefined}
        autoCapitalize={type === "email" || type === "tel" ? "none" : undefined}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="fd-input"
      />

      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-sm text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function AuthError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;

  return (
    <p
      role="alert"
      className="mb-4 rounded-md border border-danger-border bg-danger-muted px-3.5 py-2.5 text-sm font-medium text-danger"
    >
      {message}
    </p>
  );
}

export function AuthNotice({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;

  return (
    <p
      role="status"
      className="mb-4 rounded-md border border-success-border bg-success-muted px-3.5 py-2.5 text-sm font-medium text-success"
    >
      {message}
    </p>
  );
}

export function AuthSubmit({
  children,
  disabled,
  isLoading,
}: {
  children: ReactNode;
  disabled?: boolean;
  isLoading?: boolean;
}): React.JSX.Element {
  return (
    <Button
      type="submit"
      size="lg"
      fullWidth
      disabled={disabled ?? false}
      isLoading={isLoading ?? false}
      className="mt-2"
    >
      {children}
    </Button>
  );
}
