import type React from 'react';
import {
  BRAND,
  SYMBOL_BAR_BOTTOM,
  SYMBOL_BAR_TOP,
  SYMBOL_BOX,
  SYMBOL_COUNTER,
  SYMBOL_OUTLINE,
  horizontalLockup,
} from '@/lib/brand';
import { WORDMARK_PATH } from '@/lib/brand-wordmark';

export type LogoVariant = 'horizontal' | 'symbol';

interface LogoProps {
  /** `horizontal` is the primary lockup. `symbol` is the mark alone. */
  variant?: LogoVariant;
  /** Lighter sage and an off-white wordmark, for dark surfaces. */
  onDark?: boolean;
  /**
   * Accessible name.
   *
   * Omit it when the call site already supplies one — several headers pair the
   * mark with a visually hidden "Flowdesk home" label. Without a title the SVG
   * is hidden from assistive tech so the name is not announced twice.
   */
  title?: string;
  className?: string;
}

function MarkPaths({ fill }: { fill: string }) {
  return (
    <>
      {/* Outline and counter share one path so evenodd punches the hole. */}
      <path d={`${SYMBOL_OUTLINE} ${SYMBOL_COUNTER}`} fill={fill} fillRule="evenodd" />
      <path d={SYMBOL_BAR_TOP} fill={fill} />
      <path d={SYMBOL_BAR_BOTTOM} fill={fill} />
    </>
  );
}

export default function Logo({
  variant = 'horizontal',
  onDark = false,
  title,
  className,
}: LogoProps): React.JSX.Element {
  const symbolFill = onDark ? BRAND.sageLight : BRAND.sage;
  const wordFill = onDark ? BRAND.offWhite : BRAND.nearBlack;
  const labelling = title ? { role: 'img' } : { 'aria-hidden': true };

  if (variant === 'symbol') {
    return (
      <svg
        viewBox={`0 0 ${SYMBOL_BOX} ${SYMBOL_BOX}`}
        className={className ?? 'h-7 w-7'}
        focusable="false"
        {...labelling}
      >
        {title ? <title>{title}</title> : null}
        <MarkPaths fill={symbolFill} />
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
        <MarkPaths fill={symbolFill} />
      </g>
      <path
        transform={`translate(${lockup.wordmarkTranslate[0]} ${lockup.wordmarkTranslate[1]})`}
        d={WORDMARK_PATH}
        fill={wordFill}
      />
    </svg>
  );
}
