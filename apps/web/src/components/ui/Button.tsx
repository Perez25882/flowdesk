import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The application's only button.
 *
 * Consolidating it guarantees that every action shares the same hit area,
 * focus ring, disabled treatment and loading behaviour — previously each page
 * hand-rolled its own, so keyboard focus was visible in some places and not
 * others, and "saving" states varied per screen.
 *
 * Press feedback is a 0.97 scale over 100ms. It is the cheapest way to make an
 * interface feel like it is actually listening, and it is the one animation
 * here that fires on every single interaction, so it has to be fast.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover active:bg-primary-active',
  secondary:
    'bg-surface text-text-primary border border-border hover:bg-surface-hover hover:border-border-strong',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary',
  danger: 'bg-danger text-white hover:brightness-[0.93] active:brightness-[0.88]',
  link: 'bg-transparent text-primary underline decoration-primary/30 underline-offset-[3px] hover:decoration-primary p-0 h-auto',
};

/**
 * Heights meet the 44px minimum touch target at `md` and above. `sm` is for
 * dense desktop toolbars only — never for a primary action on mobile.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-sm gap-1.5',
  md: 'h-11 px-4 text-base gap-2',
  lg: 'h-12 px-6 text-md gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks input without changing the button's width. */
  isLoading?: boolean;
  /** Icon rendered before the label. Decorative — give the button real text. */
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

/**
 * Sized to the current font, so it lines up optically with the label rather
 * than sitting a fraction high the way a fixed-height spinner does.
 */
function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-[1em] w-[1em] shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80"
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    isLoading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || isLoading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      // Tells assistive tech the control is busy rather than simply broken.
      aria-busy={isLoading || undefined}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md font-semibold',
        // Named properties, never `all`: transitioning `all` animates layout
        // properties by accident and costs frames on a low-end phone.
        'transition-[background-color,border-color,color,transform,filter] duration-fast ease-out',
        'active:scale-[0.97] active:duration-instant',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none',
        VARIANTS[variant],
        variant === 'link' ? '' : SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {isLoading ? <Spinner /> : leadingIcon}
      {children}
      {!isLoading && trailingIcon}
    </button>
  );
});
