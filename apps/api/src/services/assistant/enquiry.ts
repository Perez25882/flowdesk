import type { AssistantDecision, AssistantLanguage } from '@flowdesk/shared';
import { typeNumbers } from './grounding.js';

/**
 * The shop that keeps no product list.
 *
 * A great many Ghanaian SMEs never will. A boutique selling second-hand jeans
 * has stock that turns over daily and no two items alike; a customer writes "do
 * you have baggy jeans?" and the only person who can answer is the owner,
 * looking at her rail. Asking that shop to enumerate a catalogue before
 * Flowdesk is useful to them is asking for a day of data entry to unlock a
 * feature they did not want.
 *
 * The assistant cannot answer for them, and must not pretend to. But it can
 * still do the part that actually saves them time: understand that a specific
 * thing is being asked about, hold the customer with a reply that names it, and
 * put a one-tap question in front of the owner. The customer stops waiting in
 * silence; the owner answers once instead of typing a sentence.
 *
 * Two rules make this safe.
 *
 * **The server writes the reply, not the model.** Same reasoning as
 * `clarify.ts`: an auto-sent model-written sentence is the one channel where
 * unchecked model output reaches a customer, and it is reached by processing a
 * message an attacker controls. Here the model contributes exactly one thing —
 * the customer's own words for the item — and even that is scrubbed to letters
 * before it is used.
 *
 * **The reply may claim nothing.** It is allowed to be ungrounded precisely
 * because it asserts no fact: no price, no stock, not even whether the shop
 * stocks the thing at all. `isClaimFree` enforces that deterministically rather
 * than trusting the template to stay harmless as it is edited.
 */

/**
 * The longest customer phrase worth echoing back.
 *
 * Long enough for "second hand baggy jeans", short enough that a message
 * engineered to be quoted back at length cannot turn our reply into a
 * billboard.
 */
const MAX_MENTION_LENGTH = 40;

/**
 * Anything that asserts the shop does or does not have something.
 *
 * A holding reply must not take a position either way — the whole reason it
 * exists is that nobody has looked yet. "We don't have that" is exactly as
 * wrong as "yes we have it" when the rail has not been checked, and it loses
 * the sale outright.
 */
const AVAILABILITY_CLAIMS = [
  'in stock',
  'out of stock',
  'we have',
  'we do have',
  'we have not',
  "we don't have",
  'we do not have',
  'available',
  'unavailable',
  'sold out',
  'yes we have',
  'still have',
  'got some',
  'no more',
];

const URL_PATTERN = /(https?:\/\/|www\.)\S+/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Whether this text is safe to send without any evidence behind it.
 *
 * True only for a sentence that asserts nothing checkable: no money, no counts,
 * no availability either way, no link or address. Everything the grounding
 * validator gates is gated here too, and then the bar is raised further —
 * `validateGrounding` permits an amount that appears in the evidence set, and
 * this permits no amount at all, because a reply with nothing behind it has
 * nothing to have got the figure from.
 */
export function isClaimFree(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  if (URL_PATTERN.test(trimmed)) return false;
  if (EMAIL_PATTERN.test(trimmed)) return false;

  // Reuses the validator's own number typing so the two cannot drift: a figure
  // it would read as money or stock is refused here outright.
  for (const number of typeNumbers(trimmed)) {
    if (number.kind === 'currency' || number.kind === 'stock') return false;
  }

  const lowered = trimmed.toLowerCase();
  return !AVAILABILITY_CLAIMS.some((phrase) => lowered.includes(phrase));
}

/**
 * The customer's words for what they asked about, reduced to something safe to
 * quote back.
 *
 * Letters, digits and spaces only. The model is echoing a stranger's message,
 * so everything that could carry meaning beyond a product name — punctuation,
 * fence markers, control characters, anything that could read as an instruction
 * or a URL — is removed rather than escaped. If what survives is too short to
 * be a product name, the caller falls back to a reply that names nothing.
 */
export function safeMention(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MENTION_LENGTH)
    .trim();

  // Two characters is not a product name; it is whatever survived the scrub.
  if (cleaned.length < 3) return null;

  // A bare number is a quantity, not a thing.
  if (!/\p{L}/u.test(cleaned)) return null;

  return cleaned.toLowerCase();
}

/**
 * The holding reply, in the register the customer wrote in.
 *
 * Deliberately restrained. The system prompt tells the model to match a
 * customer's tone without imitating or exaggerating it, and the same applies to
 * templates written on the shop's behalf — a Ghanaian trader reading a reply
 * that lays on Pidgin thicker than they wrote it will hear a caricature, not a
 * shopkeeper. Only the plainest register shift is worth making.
 */
function holdingPhrases(language: AssistantLanguage): { named: (item: string) => string; unnamed: string } {
  switch (language) {
    case 'pidgin':
      return {
        named: (item) => `Let me check the ${item} for you — I go come back you now now.`,
        unnamed: 'Let me check that for you — I go come back you now now.',
      };
    case 'twi_mix':
      return {
        named: (item) => `Let me check the ${item} for you — I'll come back to you shortly.`,
        unnamed: "Let me check that for you — I'll come back to you shortly.",
      };
    default:
      return {
        named: (item) => `Let me check on ${item} for you — I'll come right back.`,
        unnamed: "Let me check that for you — I'll come right back.",
      };
  }
}

export interface EnquiryHoldInput {
  decision: AssistantDecision;
  /** The customer's raw message, used only when the model named nothing. */
  message: string;
}

/**
 * Builds the reply that holds a customer while the owner is asked.
 *
 * Returns null when even the fallback would not be claim-free, which should not
 * happen with these templates but is checked rather than assumed — a template
 * edited later into something that quotes a price must fail closed, not ship.
 */
export function composeEnquiryHold(input: EnquiryHoldInput): string | null {
  const phrases = holdingPhrases(input.decision.language);

  const mention = safeMention(input.decision.entities.products[0]?.mention);
  const text = mention ? phrases.named(mention) : phrases.unnamed;

  return isClaimFree(text) ? text : null;
}

/**
 * Whether this message is a question only the owner can answer.
 *
 * Scoped tightly on purpose. It fires for a customer asking about buying
 * something — the "do you have baggy jeans?" case — and deliberately not for a
 * greeting, a complaint, a payment claim or a question about an existing order,
 * all of which the assistant either answers from records it does have or
 * escalates through paths that already exist.
 *
 * Bargaining and complaints are excluded even though the owner must handle them
 * too: those escalate with their own reasons and their own drafted replies, and
 * a holding message would read as evasion on a complaint.
 */
export function isOwnerOnlyEnquiry(decision: AssistantDecision): boolean {
  if (decision.escalate.reason === 'complaint' || decision.escalate.reason === 'bargaining') {
    return false;
  }

  const askingAboutGoods =
    decision.intent === 'INQUIRY' || decision.intent === 'ORDER' || decision.order.isOrder;

  if (!askingAboutGoods) return false;

  // An answer the model could actually ground is not owner-only — a shop with
  // no catalogue can still have opening hours and delivery areas on file, and
  // those questions should be answered rather than escalated.
  return decision.answer.groundedOn.length === 0;
}
