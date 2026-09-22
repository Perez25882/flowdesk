import { useId } from 'react';
import type React from 'react';
import { BRAND, horizontalLockup } from '@/lib/brand';
import { MARK_BOX, MARK_DARK, MARK_GRADIENTS, MARK_LIGHT, MARK_MID } from '@/lib/brand-mark';
import { WORDMARK_PATH } from '@/lib/brand-wordmark';

export type LogoVariant = 'horizontal' | 'symbol';

interface LogoProps {
  /** `horizontal` is the primary lockup. `symbol` is the mark alone. */
  variant?: LogoVariant;
  /** A lighter stack and an off-white wordmark, for dark surfaces. */
  onDark?: boolean;
  /**
   * Accessible name.
   *
   * Omit it when the call site already supplies one. Several headers pair the
   * mark with a visually hidden "Flowdesk home" label, and without a title the
   * SVG is hidden from assistive tech so the name is not announced twice.
   */
  title?: string;
  className?: string;
}

/**
 * The three blades.
 *
 * Gradient ids are generated per instance with `useId`. Two logos on one page,
 * the header and the footer, would otherwise both point at `#fdg0`, and
 * whichever mounted second would silently repaint the first. That bug looks
 * like a logo that changes colour when you navigate.
 */
function Mark({ onDark }: { onDark: boolean }): React.JSX.Element {
  const uid = useId().replace(/:/g, '');

  const layers = [
    { key: 'light', paths: MARK_LIGHT },
    { key: 'mid', paths: MARK_MID },
    { key: 'dark', paths: MARK_DARK },
  ] as const;

  return (
    <>
      <defs>
        {layers.map(({ key }) => {
          const [from, to] = MARK_GRADIENTS[key];
          return (
            <linearGradient key={key} id={`${uid}-${key}`} x1="0" y1="0" x2="0.9" y2="1">
              <stop offset="0" stopColor={from} />
              <stop offset="1" stopColor={to} />
            </linearGradient>
          );
        })}
      </defs>

      {layers.map(({ key, paths }) =>
        paths.map((d, index) => (
          <path
            key={`${key}-${index}`}
            d={d}
            fill={`url(#${uid}-${key})`}
            // On ink, the darkest blade would disappear into the background.
            // Lifting the whole stack is wrong (it loses the depth that is the
            // mark's whole idea), so only the bottom blade is brightened.
            opacity={onDark && key === 'dark' ? 0.72 : 1}
          />
        )),
      )}
    </>
  );
}

export default function Logo({
  variant = 'horizontal',
  onDark = false,
  title,
  className,
}: LogoProps): React.JSX.Element {
  const wordFill = onDark ? BRAND.offWhite : BRAND.nearBlack;
  const labelling = title ? { role: 'img' } : { 'aria-hidden': true };

  if (variant === 'symbol') {
    return (
      <svg
        viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}
        className={className ?? 'h-7 w-7'}
        focusable="false"
        {...labelling}
      >
        {title ? <title>{title}</title> : null}
        <Mark onDark={onDark} />
      </svg>
    );
  }

  const lockup = horizontalLockup();

  return (
    <svg
      viewBox={`0 0 ${lockup.width} ${lockup.height}`}
      className={className ?? 'h-6 w-auto'}
      focusable="false"
      {...labelling}
    >
      {title ? <title>{title}</title> : null}
      <g transform={`scale(${lockup.symbolScale})`}>
        <Mark onDark={onDark} />
      </g>
      <path
        transform={`translate(${lockup.wordmarkTranslate[0]} ${lockup.wordmarkTranslate[1]})`}
        d={WORDMARK_PATH}
        fill={wordFill}
      />
    </svg>
  );
}
