import {
  IDENTIFIER_DIGITS,
  digitsOnly,
  toMinorUnits,
  type EvidenceSet,
} from './evidence.js';

/**
 * Checks a generated reply before it can be sent unsupervised.
 *
 * The problem this solves: a fluent, confident, wrong price. The model is not
 * trusted to police itself, so every money figure and stock count in the text is
 * compared against values the SERVER computed from real rows.
 *
 * The hard part is not catching wrong numbers — it is not rejecting right ones.
 * A correct reply is full of legitimate figures that appear in no database row:
 * quantities ("2 bags"), times ("we close at 6pm"), pack sizes ("33cl"), dates,
 * order references. A naive "any number not in the evidence set fails" rejects
 * nearly every good answer, and the feature silently degrades to drafting
 * everything. So numbers are TYPED first, and only the two types that can
 * mislead about money or availability are actually gated.
 */

export type GroundingFailure =
  | 'unverified_amount'
  | 'unverified_stock_claim'
  | 'availability_contradicts_stock'
  | 'unknown_order_reference'
  | 'foreign_phone_number'
  | 'contains_url'
  | 'contains_email'
  | 'ungrounded_claim'
  | 'empty';

export interface GroundingResult {
  ok: boolean;
  failures: GroundingFailure[];
}

/** Number words the model may reasonably spell out in a price. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

const CURRENCY_BEFORE = /(?:ghs|ghc|gh₵|₵|cedis?)\s*$/i;
const CURRENCY_AFTER = /^\s*(?:ghs|ghc|gh₵|₵|cedis|cedi|pesewas?)\b/i;
const STOCK_BEFORE = /(?:only|just|we have|got|there(?:'s| is| are))\s*$/i;
/**
 * Words that make a number a claim about how many exist.
 *
 * Bare unit nouns — "2 bags", "3 bottles" — are deliberately NOT here. They are
 * the customer's quantity, not the shop's stock level, and gating them meant a
 * correct subtotal ("2 bags of Rice 5kg is GHS 160") was rejected because 2 is
 * not one of the catalogue's stock counts. A real stock claim reaches
 * `STOCK_BEFORE` ("we have 3…") or one of the words below.
 */
const STOCK_AFTER = /^\s*(?:left|remaining|in stock|available)\b/i;
const TIME_LIKE = /^\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const PACK_SIZE_AFTER = /^\s*(?:kg|g|ml|cl|l|litres?|liters?|oz|pcs|pack)\b/i;




const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const ORDER_REF_PATTERN = /\bFD-[A-Z0-9]{3,}\b/gi;
const PHONE_PATTERN = /\+?\d[\d\s-]{6,}\d/g;

/**
 * A run of number words, which `PHONE_PATTERN` cannot see because it reads
 * figures. Ghanaian numbers are routinely dictated this way — "oh two four" —
 * so a spelled-out run is a phone number far more often than it is prose.
 *
 * Three or more, because "one moment" and "two things" are ordinary speech and
 * a run of three is not.
 */
const NUMBER_WORD = 'zero|oh|one|two|three|four|five|six|seven|eight|nine';
const SPELLED_NUMBER_RUN = new RegExp(
  `\\b(?:${NUMBER_WORD})\\b(?:[\\s,.-]+\\b(?:${NUMBER_WORD})\\b){2,}`,
  'i',
);

/**
 * Phrases that move a customer's money or contact somewhere the shop has not
 * told us about. Not facts we can check — claims we can never allow a model to
 * make unread, because the damage lands on the shop's own number.
 */
const REDIRECTION_PHRASES = [
  'send to',
  'send it to',
  'send the money to',
  'pay to',
  'pay into',
  'transfer to',
  'new number',
  'new momo',
  'new account',
  'changed to',
  'use this number',
  'call this number',
  'contact us on',
];

const AVAILABILITY_AFFIRMATIONS = [
  'in stock',
  'we have',
  'we do have',
  'available',
  'yes we have',
  'still have',
  'got some',
];

interface TypedNumber {
  value: number;
  kind: 'currency' | 'stock' | 'time' | 'pack_size' | 'quantity';
}

/**
 * Classifies each number by the words around it.
 *
 * Only `currency` and `stock` are ever gated. Everything else is allowed
 * through: a quantity, a closing time and a pack size are all normal parts of a
 * correct sentence and none of them can mislead a customer about what something
 * costs or whether it exists.
 */
export function typeNumbers(text: string): TypedNumber[] {
  const found: TypedNumber[] = [];

  // Digit forms, including thousands separators and decimals.
  const numeric = /\d[\d,]*(?:\.\d+)?/g;
  let match: RegExpExecArray | null;

  while ((match = numeric.exec(text)) !== null) {
    const raw = match[0];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + raw.length);
    const digits = raw.replace(/[^\d]/g, '');

    // Phone numbers and other identifiers are handled separately.
    if (digits.length >= IDENTIFIER_DIGITS) continue;

    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;

    if (TIME_LIKE.test(raw + after)) {
      found.push({ value, kind: 'time' });
      continue;
    }

    if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) {
      found.push({ value, kind: 'currency' });
      continue;
    }

    if (PACK_SIZE_AFTER.test(after)) {
      found.push({ value, kind: 'pack_size' });
      continue;
    }

    if (STOCK_BEFORE.test(before) || STOCK_AFTER.test(after)) {
      found.push({ value, kind: 'stock' });
      continue;
    }

    found.push({ value, kind: 'quantity' });
  }

  // Spelled-out money: "fifty cedis".
  const worded = new RegExp(
    `\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b(?=\\s*(?:ghs|ghc|cedis?|pesewas?))`,
    'gi',
  );

  while ((match = worded.exec(text)) !== null) {
    const value = NUMBER_WORDS[match[1]!.toLowerCase()];
    if (value !== undefined) found.push({ value, kind: 'currency' });
  }

  return found;
}

/**
 * Whether this text asserts anything a customer could be misled by.
 *
 * The citation rule exists because a price or a stock level has to come from a
 * row. "Morning!" and "You're welcome" come from nowhere and need to — there is
 * no row behind a greeting, so demanding one meant the friendliest replies the
 * assistant produced were the ones held back for approval. Once the prompt
 * started asking for warmth, that turned into most of them.
 *
 * So the question is not "did it cite something" but "did it claim something".
 * Anything with money, a stock count, an order reference or an availability
 * affirmation in it is a claim and still needs its evidence. A bare pleasantry
 * is not.
 */
export function assertsCheckableFact(text: string): boolean {
  const lowered = text.toLowerCase();

  // Any digit at all is a specific claim about the world.
  //
  // The typed checks below catch money and stock, which were the obvious
  // dangers. They do not catch an opening time, and that gap reached a customer:
  // asked "what time do you open?" for a shop with no hours recorded, the model
  // answered "We open at 8am". No currency, no stock count, so every check here
  // passed it as claim-free. A wrong opening time costs a shop a morning of
  // customers standing at a closed door, which is worse than a wrong price they
  // would at least have argued about.
  //
  // Rather than enumerate times, dates, weights and delivery fees one pattern at
  // a time, treat a digit as what it is: the shop asserting something specific,
  // which must rest on a row somebody supplied. Replies with nothing to verify —
  // "hello", "we don't sell that", "alright, anytime" — carry no digits and are
  // unaffected.
  if (/\d/.test(text)) return true;

  if (AVAILABILITY_AFFIRMATIONS.some((phrase) => lowered.includes(phrase))) return true;
  if (ORDER_REF_PATTERN.test(text)) return true;

  // Reset: both patterns are /g and carry lastIndex between calls.
  ORDER_REF_PATTERN.lastIndex = 0;

  // A digit sequence spelled out is still a digit sequence. Every numeric check
  // in this file reads figures, so "send to zero two four four, one two three"
  // carries a whole MoMo number past all of them and out to the customer under
  // the shop's own name. Three in a row, because "one moment" is not a number.
  if (SPELLED_NUMBER_RUN.test(text)) return true;

  // Sending a customer's money or attention somewhere new is a claim about the
  // shop — and the one with the worst consequences if it is wrong. It cites
  // nothing, contradicts no stock and contains no figure, so nothing else here
  // would stop it.
  if (REDIRECTION_PHRASES.some((phrase) => lowered.includes(phrase))) return true;

  // A link asserts something we have no evidence for and cannot check at all.
  if (/https?:\/\/|\bwww\./i.test(lowered)) return true;

  return typeNumbers(text).some(
    (number) => number.kind === 'currency' || number.kind === 'stock',
  );
}

export interface ValidateInput {
  text: string;
  evidence: EvidenceSet;
  /** Ids the answer claims to rest on, already filtered to known ones. */
  groundedOn: string[];
  /** Stock levels of the products actually cited, for the affirmation check. */
  citedStock: number[];
  /**
   * Whether this reply must cite evidence. Defaults to true. Cleared only for
   * a reply the router has already established asserts nothing checkable.
   */
  requireCitation?: boolean;
}

/**
 * Whether this text may be sent without a person reading it first.
 *
 * Returns every failure rather than the first, so the dashboard can tell the
 * owner what to look at instead of just "not verified".
 */
export function validateGrounding(input: ValidateInput): GroundingResult {
  const { text, evidence } = input;
  const failures: GroundingFailure[] = [];

  if (text.trim().length === 0) {
    return { ok: false, failures: ['empty'] };
  }

  // An auto-sent message must never carry a link or an address — that is how a
  // shop's own assistant gets used to relay someone else's payment details.
  if (URL_PATTERN.test(text)) failures.push('contains_url');
  if (EMAIL_PATTERN.test(text)) failures.push('contains_email');

  for (const phoneMatch of text.match(PHONE_PATTERN) ?? []) {
    // Both sides go through the same Ghanaian normaliser, so the local and
    // international spellings of the shop's own number compare equal.
    const normalized = digitsOnly(phoneMatch);
    if (normalized.length < IDENTIFIER_DIGITS) continue;

    if (!evidence.ownPhoneDigits.has(normalized)) {
      failures.push('foreign_phone_number');
      break;
    }
  }

  for (const ref of text.match(ORDER_REF_PATTERN) ?? []) {
    if (!evidence.allowedOrderRefs.has(ref.toUpperCase())) {
      failures.push('unknown_order_reference');
      break;
    }
  }

  for (const number of typeNumbers(text)) {
    if (number.kind === 'currency') {
      if (!evidence.allowedAmounts.has(toMinorUnits(number.value))) {
        failures.push('unverified_amount');
      }
      continue;
    }

    if (number.kind === 'stock') {
      if (!evidence.allowedStockCounts.has(number.value)) {
        failures.push('unverified_stock_claim');
      }
    }
  }

  // "Yes, we have it" contains no number at all and passes every check above,
  // so availability is checked against the stock of what was actually cited.
  if (input.citedStock.length > 0 && input.citedStock.every((quantity) => quantity <= 0)) {
    const lowered = text.toLowerCase();
    if (AVAILABILITY_AFFIRMATIONS.some((phrase) => lowered.includes(phrase))) {
      failures.push('availability_contradicts_stock');
    }
  }

  // An answer resting on nothing is not grounded, however plausible it reads.
  // "Sure, that should be fine" carries no number and is still a commitment.
  //
  // The one exception is decided by the caller, not here: a reply the router
  // has established is a bare pleasantry has nothing to cite, and the caller
  // says so by clearing `requireCitation`. Keeping the default strict means a
  // new call site has to opt out deliberately.
  if (input.requireCitation !== false && input.groundedOn.length === 0) {
    failures.push('ungrounded_claim');
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}
