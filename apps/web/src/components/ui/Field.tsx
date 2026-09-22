import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Form field primitives.
 *
 * Every control gets a real `<label>` bound by id, an optional hint, and an
 * error that is announced rather than merely coloured red. Previously each
 * page hand-rolled these, so some inputs had no label at all and errors were
 * conveyed by border colour alone, invisible to a screen reader and to
 * anyone with a red-green deficiency.
 */

interface FieldShellProps {
  label: string;
  htmlFor: string;
  /**
   * Explanatory text shown under the label, before the control.
   *
   * `| undefined` is spelled out on the optional props because the project
   * runs with `exactOptionalPropertyTypes`, under which `hint?: string` and
   * `hint?: string | undefined` are different types, the former refuses an
   * explicitly-passed `undefined`, which is exactly what forwarding an
   * optional prop through produces.
   */
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
}

export function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldShellProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-text-primary">
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}

      {children}

      {/* `role="alert"` so the message is read the moment it appears, rather
          than only when the field is next focused. */}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  id?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, id, required, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <input
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        className="fd-input"
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  id?: string;
  children: ReactNode;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, className, id, required, children, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <select
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        className="fd-input fd-select"
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
});

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  id?: string;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, hint, error, className, id, required, rows = 3, ...rest }, ref) {
    const generated = useId();
    const fieldId = id ?? generated;

    return (
      <FieldShell
        label={label}
        htmlFor={fieldId}
        hint={hint}
        error={error}
        required={required}
        className={className}
      >
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          className="fd-input resize-y"
          {...rest}
        />
      </FieldShell>
    );
  },
);

/**
 * Bare select for toolbars, where a visible label would be noise but assistive
 * tech still needs one.
 */
export const InlineSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { 'aria-label': string }
>(function InlineSelect({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'fd-input fd-select fd-input-compact h-10 w-auto py-0 sm:h-9',
        'cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
