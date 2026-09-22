/**
 * Flowdesk brand geometry, the single source of truth for the mark.
 *
 * The symbol is drawn on the brand sheet's 10x10 construction grid, expressed
 * here at 100 units so every value stays a whole number: stroke 1.5x = 15,
 * corner radius 0.5x = 5, bar height 1.5x = 15, gap 2x = 20, arc outer
 * radius 5x = 50.
 *
 * The <Logo /> component draws from these constants rather than from the SVGs
 * in public/, so the header mark and the static favicon cannot drift apart.
 */

import { WORDMARK_BOX } from './brand-wordmark';

/** Outer silhouette: a rounded square whose right edge bows into a half-circle. */
export const SYMBOL_OUTLINE =
  'M5 0 H50 A50 50 0 0 1 50 100 H5 A5 5 0 0 1 0 95 V5 A5 5 0 0 1 5 0 Z';

/**
 * The counter punched out of the outline.
 *
 * Drawn as a second subpath on the same `<path>` with `fill-rule="evenodd"`,
 * not as a background-coloured shape on top, the mark has to work on any
 * surface, and a painted-on counter would show its seams over a photo.
 */
export const SYMBOL_COUNTER =
  'M20 15 H50 A35 35 0 0 1 50 85 H20 A5 5 0 0 1 15 80 V20 A5 5 0 0 1 20 15 Z';

export const SYMBOL_BAR_TOP = 'M15 25 H60 A5 5 0 0 1 65 30 V35 A5 5 0 0 1 60 40 H15 Z';

export const SYMBOL_BAR_BOTTOM = 'M15 60 H60 A5 5 0 0 1 65 65 V70 A5 5 0 0 1 60 75 H15 Z';

/** The symbol's artboard is square. */
export const SYMBOL_BOX = 100;

/**
 * The mark's own colours, outside the CSS token system on purpose.
 *
 * These are baked into static SVGs in public/ and into a `theme-color` meta
 * tag, none of which can read a custom property. They have to be literals, and
 * they have to be changed in step with the palette, which is why they are
 * named for their role rather than for the hue, so the next change does not
 * leave a constant called `sage` holding a blue.
 */
export const BRAND = {
  /** The mark's fill, and the browser chrome colour. Matches --blue-800. */
  primary: '#2a3e4b',
  /** One step lighter, for the mark on a dark ground. Matches --blue-600. */
  primaryLight: '#4d7489',
  /** The lightest surface in the palette. Matches --blue-50. */
  offWhite: '#f7fbfd',
  surface: '#152029',
  nearBlack: '#0f161a',
} as const;

/**
 * Lockup ratios, taken from the brand sheet's ARTWORK rather than its
 * annotations, the two disagree.
 *
 * The annotations call for a symbol matched to the x-height with a one-stroke
 * gap. The drawn lockup sets the symbol to the full ascender height and the gap
 * to 0.28 of the symbol's width. The artwork is what everyone has actually
 * seen, so the artwork wins.
 */
export const SYMBOL_TO_ASCENDER = 1;
export const GAP_TO_SYMBOL_WIDTH = 0.28;

export interface Lockup {
  width: number;
  height: number;
  symbolScale: number;
  /** Baseline origin for the wordmark path, as [x, y]. */
  wordmarkTranslate: readonly [number, number];
}

/**
 * Rounds to two decimals.
 *
 * `0.28` has no exact binary representation, so the raw arithmetic below lands
 * on tails like `489.35999999999996`. Those tails are harmless in a viewBox but
 * they make the component's output differ from the committed SVGs for no
 * reason, and long decimals in markup invite someone to "tidy" them wrongly.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Symbol left of the wordmark, sharing a baseline. The primary lockup. */
export function horizontalLockup(): Lockup {
  const ascender = -WORDMARK_BOX.y;
  const symbolSize = ascender * SYMBOL_TO_ASCENDER;
  const gap = symbolSize * GAP_TO_SYMBOL_WIDTH;
  // The wordmark path is inset by WORDMARK_BOX.x from its own origin, so the
  // origin is pulled back by that much to leave a true optical gap.
  const wordmarkX = round2(symbolSize + gap - WORDMARK_BOX.x);

  return {
    width: round2(wordmarkX + WORDMARK_BOX.x + WORDMARK_BOX.width),
    height: WORDMARK_BOX.height,
    symbolScale: round2(symbolSize / SYMBOL_BOX),
    wordmarkTranslate: [wordmarkX, ascender],
  };
}
