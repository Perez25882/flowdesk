/**
 * Deciding whether an inbound image is a MoMo payment screenshot.
 *
 * Everything here runs on metadata the worker already holds by the time the
 * webhook lands — the mime type, the caption, and whether this customer owes
 * money — plus the image's dimensions on the occasions the bytes were actually
 * fetched. No pixels are read and no text is extracted: OCR is deliberately out
 * of scope (PRD 3.5), because an amount misread off a cropped, re-compressed
 * screenshot is worse than no amount at all. The owner reads the amount; this
 * only decides whether to put the image in front of them.
 *
 * The previous version flagged on caption keywords alone, which meant the most
 * common case in Ghana — a bare screenshot with no caption — was never flagged
 * at all.
 */

/**
 * How sure we have to be before putting an image in the owner's review queue.
 *
 * Deliberately low, because the two errors cost wildly different amounts. A
 * false positive costs the owner one tap to dismiss. A false negative means a
 * customer's proof of payment never becomes a payment record, which is the
 * dispute this product exists to prevent — the money is already gone by the
 * time anyone notices. 0.6 is the point where a bare screenshot from a customer
 * who owes money gets through, while an ordinary captioned photo of a product
 * does not.
 */
export const MOMO_SCREENSHOT_FLAG_THRESHOLD = 0.6;

/**
 * Any image from a customer starts here. A shop's WhatsApp thread is not a
 * photo album: images arrive to prove something, and proof of payment is the
 * commonest thing there is to prove.
 */
const BASE_IMAGE_SCORE = 0.3;

/** The caption names money, a network, or the act of paying. */
const PAYMENT_CAPTION_SCORE = 0.45;

/** The caption also carries something that looks like an amount ("450", "GHS 450"). */
const AMOUNT_IN_CAPTION_SCORE = 0.15;

/** This customer has an order with money still outstanding on it. */
const OPEN_UNPAID_ORDER_SCORE = 0.35;

/** The image is shaped like a phone screen capture rather than a photograph. */
const SCREENSHOT_SHAPE_SCORE = 0.3;

/**
 * The customer wrote a caption and none of it is about money. Someone asking
 * "is this the right bag?" over a product photo has told us what the image is
 * for, and it is not a payment.
 */
const UNRELATED_CAPTION_PENALTY = -0.15;

const PAYMENT_KEYWORDS = [
  'momo',
  'mtn',
  'vodafone',
  'telecel',
  'airteltigo',
  'airtel',
  'tigo',
  'payment',
  'paid',
  'pay',
  'sent',
  'sending',
  'transfer',
  'transaction',
  'receipt',
  'screenshot',
  'cedis',
  'ghs',
  'ghc',
];

/**
 * A number big enough to be a price. Two digits or more, so "3 bags" and
 * "2 cartons" do not read as amounts.
 */
const AMOUNT_PATTERN = /(?:ghs|ghc|gh₵|₵)\s*\d|\b\d{2,7}(?:\.\d{1,2})?\b/i;

/**
 * Screen captures are tall and narrow — 16:9 at the squarest, usually 19.5:9 —
 * and photographs are 4:3 or 3:2 whichever way they are held. WhatsApp
 * re-compresses inbound images but preserves aspect ratio, so the ratio
 * survives the trip where the pixel count does not. A cropped screenshot loses
 * this signal, which only costs it the bonus: nothing here subtracts.
 */
const SCREENSHOT_MIN_ASPECT_RATIO = 1.9;
const SCREENSHOT_MAX_WIDTH = 2000;

export interface ScreenshotSignals {
  mimeType: string;
  caption?: string | null;
  /** True when the customer has an order with money still outstanding. */
  hasOpenUnpaidOrder?: boolean;
  /** Known only once the bytes have been fetched, so frequently absent. */
  dimensions?: { width: number; height: number } | undefined;
}

export interface ScreenshotAssessment {
  /** 0 to 1. Not a probability — a ranking, calibrated against the threshold. */
  confidence: number;
  flagged: boolean;
  /**
   * Why, in plain words. Recorded on the claim so an owner looking at a
   * dismissal can see what the detector thought it had, and so a bad rule can
   * be found from the data rather than guessed at.
   */
  reasons: string[];
}

function captionMentionsPayment(caption: string): boolean {
  return PAYMENT_KEYWORDS.some((keyword) => caption.includes(keyword));
}

function looksLikeAScreenCapture(dimensions: { width: number; height: number }): boolean {
  if (dimensions.width <= 0 || dimensions.height <= 0) return false;
  if (dimensions.width > SCREENSHOT_MAX_WIDTH) return false;
  return dimensions.height / dimensions.width >= SCREENSHOT_MIN_ASPECT_RATIO;
}

/**
 * Scores an inbound image against the signals available for it.
 *
 * Every input is optional except the mime type, and the result is honest about
 * how little it knows: the confidence is a ranking against
 * `MOMO_SCREENSHOT_FLAG_THRESHOLD`, not a claim about the world.
 */
export function assessMoMoScreenshot(signals: ScreenshotSignals): ScreenshotAssessment {
  if (!signals.mimeType.startsWith('image/')) {
    return { confidence: 0, flagged: false, reasons: [] };
  }

  const reasons: string[] = [];
  let score = BASE_IMAGE_SCORE;

  const caption = signals.caption?.trim().toLowerCase() ?? '';

  if (caption.length > 0 && captionMentionsPayment(caption)) {
    score += PAYMENT_CAPTION_SCORE;
    reasons.push('the caption mentions payment');

    if (AMOUNT_PATTERN.test(caption)) {
      score += AMOUNT_IN_CAPTION_SCORE;
      reasons.push('the caption contains an amount');
    }
  } else if (caption.length > 0) {
    score += UNRELATED_CAPTION_PENALTY;
    reasons.push('the caption is about something else');
  }

  if (signals.hasOpenUnpaidOrder === true) {
    score += OPEN_UNPAID_ORDER_SCORE;
    reasons.push('the customer has an order with money outstanding');
  }

  if (signals.dimensions && looksLikeAScreenCapture(signals.dimensions)) {
    score += SCREENSHOT_SHAPE_SCORE;
    reasons.push('the image is shaped like a phone screenshot');
  }

  const confidence = Math.min(1, Math.max(0, Number(score.toFixed(2))));

  return {
    confidence,
    flagged: confidence >= MOMO_SCREENSHOT_FLAG_THRESHOLD,
    reasons,
  };
}
