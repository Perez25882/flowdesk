import { useCallback, useState, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Logo from '@/components/shared/Logo';
import { cn } from '@/lib/utils';

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
 * checkable statements, no logos we do not have, no testimonials we did not
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
    <div className="fd-aurora min-h-[100dvh] bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      {/* ── The form ── */}
      <div className="relative flex min-h-[100dvh] flex-col px-5 py-6 sm:px-8 lg:min-h-0 lg:px-12 lg:py-10">
        <header className="shrink-0">
          <Link
            to="/"
            className="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Logo />
            <span className="sr-only">Flowdesk home</span>
          </Link>
        </header>

        {/* Top-aligned on small screens so the on-screen keyboard cannot push
            the form out of view; centred once there is room. */}
        <main className="flex flex-1 items-start pb-10 pt-10 sm:items-center sm:pt-6">
          {/*
            Seated in a card from `sm:` up, full-bleed below it.

            On a phone a card is a frame around a form that already fills the
            screen: it costs 32px of the width the fields need and gives
            nothing back. On anything wider, a form floating on an open
            background is the thing every side project ships, and this is the
            screen where someone decides whether to hand over the number their
            business runs on. So the card appears exactly where there is room
            for it to mean something.
          */}
          <div className="w-full max-w-[400px] sm:rounded-2xl sm:bg-surface sm:p-9 sm:shadow-lg sm:ring-1 sm:ring-border-subtle lg:mx-auto">
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
      {/*
        Inverted, like the band on the public page.

        It was white-on-white with a hairline between: honest, and completely
        weightless, half the screen doing nothing on the one page where
        someone is deciding whether to trust this with the number their
        business runs on. A dark panel gives the page a spine, and it is the
        same ink the marketing page already uses, so it is the system speaking
        rather than a new idea.
      */}
      <aside className="fd-ink fd-grain relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-center lg:px-14">
        <div
          aria-hidden="true"
          className="fd-ruled-ink pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(110%_70%_at_100%_40%,#000_10%,transparent_75%)]"
        />

        <div className="relative max-w-sm">
          <Logo variant="symbol" onDark className="h-10 w-10" />

          {/* No manual line break. A forced break is set for one viewport and
              wrong at every other, and this panel only exists above `lg:`
              where the measure is already controlled by the column width. */}
          <p className="mt-8 max-w-[15ch] text-3xl font-bold leading-[1.15] tracking-tight text-white">
            Nothing changes for your customers.
          </p>

          {/*
            Rules became chips. The copy is untouched, every line here is
            still a statement that can be checked against the product, and
            none of it is a logo we do not have or a testimonial nobody gave
            us. What changed is only that three identical ruled rows read as
            small print, and small print is not what reassures anybody.
          */}
          <dl className="mt-10 flex flex-col gap-7">
            {ASSURANCES.map((item, index) => (
              <div key={item.head} className="flex gap-4">
                {/*
                  A number, not an icon. The previous version repeated one
                  shield three times, which looks considered and carries no
                  information at all: the same glyph beside three different
                  claims tells you nothing about any of them. A numeral at
                  least says how many there are and in what order.
                */}
                <span className="fd-figure mt-0.5 w-4 shrink-0 text-sm font-bold text-white/35">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <dt className="text-base font-bold tracking-tight text-white">{item.head}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-text-on-ink-muted">
                    {item.body}
                  </dd>
                </div>
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
  /**
   * Validate when the field loses focus, not on every keystroke.
   *
   * Checking as someone types tells them their email is invalid before they
   * have finished typing it, which is hostile. The caller re-validates on
   * change only once a field has already errored, so a correction clears the
   * message immediately.
   */
  onBlur?: () => void;
  /** Lets a failed submit move focus to the first field that failed. */
  // `Ref`, not `RefObject`: it is what the DOM `ref` prop actually accepts, so
  // it takes both a `useRef` object and a callback ref. `RefObject<T | null>`
  // is the React 19 spelling and does not assign to this project's React 18
  // `LegacyRef`, because a `useRef(null)` object is allowed to still hold null.
  inputRef?: Ref<HTMLInputElement>;
  inputMode?: 'text' | 'email' | 'tel' | 'numeric';
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
  onBlur,
  inputRef,
  inputMode,
}: AuthFieldProps): React.JSX.Element {
  // The hint is not rendered while an error is showing, so naming it here
  // pointed assistive tech at an element that does not exist and the hint was
  // announced as nothing at all.
  const showHint = Boolean(hint) && !error;
  const hintId = showHint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const isPassword = type === 'password';
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          name={id}
          ref={inputRef}
          type={isPassword && revealed ? 'text' : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          inputMode={inputMode}
          autoComplete={autoComplete}
          placeholder={placeholder}
          // Autocorrect on an email or phone field turns a valid address into
          // a red squiggle and, on iOS, sometimes into a different address.
          spellCheck={type === "email" || type === "tel" || type === "password" ? false : undefined}
          autoCapitalize={type === "email" || type === "tel" ? "none" : undefined}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          // A message under the field is easy to miss on a phone, where the
          // keyboard covers the lower half of the screen. The border is what
          // is actually visible when someone scrolls back up looking for what
          // went wrong.
          className={cn(
            'fd-input',
            isPassword && 'pr-11',
            error && 'border-danger focus:border-danger focus:ring-danger/30',
          )}
        />

        {/*
          Show/hide, on the one field where typing is blind.
          Not a nicety: this form is filled on a phone, one-handed, often
          outdoors, and the commonest reason a correct password is rejected is
          that the person could not see they had fat-fingered it. The toggle
          resets to hidden on every mount, so a revealed password never
          survives a navigation.
        */}
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            // Excluded from the tab order. Someone tabbing email → password →
            // submit should not land here first; anyone who wants it can reach
            // it by touch or by shift-tabbing back.
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-text-muted transition-colors duration-fast ease-out hover:text-text-primary"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {showHint && (
        <p id={hintId} className="mt-1.5 text-sm text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Validation that waits until someone has finished typing.
 *
 * Two rules, and the order matters. A field is only judged when it loses focus
 * AND has something in it, so tabbing through an empty form raises nothing and
 * "you left this blank" is saved for submit. Once a field has failed, it is
 * re-checked on every keystroke, so the message disappears the moment it stops
 * being true rather than making the person guess and re-blur.
 */
/**
 * One message per field, absent when the field is fine.
 *
 * Spelt out rather than written `Partial<Record<K, string>>` because this
 * project builds with `exactOptionalPropertyTypes`, under which those two are
 * not the same type: `Partial` lets the key be MISSING, but not present holding
 * `undefined`. Validators here return `string | undefined`, and the natural way
 * to write a whole form's result is an object literal with a key per field — so
 * the value assigned really is `undefined` for the fields that passed, and that
 * has to be sayable.
 */
export type FieldErrors<K extends string> = { [P in K]?: string | undefined };

export function useFieldErrors<K extends string>(
  validate: (field: K, value: string) => string | undefined,
): {
  errors: FieldErrors<K>;
  handleBlur: (field: K, value: string) => void;
  handleChange: (field: K, value: string) => void;
  setErrors: (next: FieldErrors<K>) => void;
  clear: (field: K) => void;
} {
  const [errors, setErrors] = useState<FieldErrors<K>>({});

  const handleBlur = useCallback(
    (field: K, value: string) => {
      if (value.trim() === '') return;
      const message = validate(field, value);
      setErrors((current) => ({ ...current, [field]: message }));
    },
    [validate],
  );

  const handleChange = useCallback(
    (field: K, value: string) => {
      setErrors((current) => {
        if (!current[field]) return current;
        return { ...current, [field]: validate(field, value) };
      });
    },
    [validate],
  );

  const clear = useCallback((field: K) => {
    setErrors((current) => ({ ...current, [field]: undefined }));
  }, []);

  return { errors, handleBlur, handleChange, setErrors, clear };
}

/**
 * Splits a server error into the field it belongs to and the rest.
 *
 * The API returns validation failures as "email: must be an email;
 * password: too short", so each part can go under the field it is about
 * instead of every one of them landing in a banner the eye has already
 * skipped. Anything unattributable stays form-level, which is correct for
 * wrong-credentials, lockouts and network failures: those are about the
 * attempt, not about one box.
 */
export function splitApiError<K extends string>(
  message: string | null,
  fields: readonly K[],
): { fieldErrors: Partial<Record<K, string>>; formError: string | null } {
  if (!message) return { fieldErrors: {}, formError: null };

  const fieldErrors: Partial<Record<K, string>> = {};
  const leftovers: string[] = [];

  for (const part of message.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;

    const match = /^([a-zA-Z]+)\s*:\s*(.+)$/.exec(trimmed);
    const key = match?.[1] as K | undefined;

    if (key && fields.includes(key) && match?.[2]) {
      // Server copy is terse ("must be an email"); a capital reads as a
      // sentence under the field rather than as a fragment.
      const text = match[2];
      fieldErrors[key] = text.charAt(0).toUpperCase() + text.slice(1);
    } else {
      leftovers.push(trimmed);
    }
  }

  return {
    fieldErrors,
    formError: leftovers.length > 0 ? leftovers.join('. ') : null,
  };
}

/** Good enough to catch a typo, deliberately not RFC 5322. */
export function validateEmailShape(value: string): string | undefined {
  if (value.trim() === '') return 'Enter your email address.';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? undefined
    : 'That does not look like an email address.';
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
