import type { BusinessProfile } from '@flowdesk/shared';
import { isGhanaPhone, normalizeGhanaPhone } from '../../utils/phone.js';

/**
 * Getting a deliverable address out of a WhatsApp conversation.
 *
 * An order that has been confirmed is not yet an order anyone can hand to a
 * rider: it has a price and a customer but no name, no street and no number to
 * ring on arrival. Before this, those details, when a customer happened to give
 * them, survived only as free text inside `orders.rawMessage` — legible to a
 * person and to nothing else. They are columns now, and this is what fills them.
 *
 * Three rules this module holds to.
 *
 * **The server composes every question.** Same rule as `clarify.ts`, for the
 * same reason: a question written by the model is the one place unchecked model
 * output would reach a customer, and it is reached by processing a message an
 * attacker controls. Templating the question closes that channel. The cost is
 * slightly stiffer phrasing.
 *
 * **The whole reply is the answer.** We asked one specific question, so the
 * message that comes back is the answer to it. Taking the body literally (after
 * stripping the lead-ins people actually type) is both more reliable than
 * asking a model to extract a field and immune to the message arguing with us
 * about what it is.
 *
 * **Nobody is asked twice.** A returning customer is shown what we already have
 * and asked to confirm it, which is one message instead of three.
 */

export const DELIVERY_FIELDS = ['recipientName', 'deliveryAddress', 'contactPhone'] as const;
export type DeliveryField = (typeof DELIVERY_FIELDS)[number];

export interface DeliveryDetails {
  recipientName: string | null;
  deliveryAddress: string | null;
  contactPhone: string | null;
}

/** Longest answer we will store. Past this it is a paragraph, not an address. */
const MAX_FIELD_LENGTH = 180;
const MAX_NAME_LENGTH = 70;

/**
 * Lead-ins people actually type, stripped so the column holds "Ama Boateng"
 * rather than "my name is Ama Boateng".
 *
 * Deliberately conservative: only phrases that are unambiguously preamble. A
 * customer who writes "The Blue House, East Legon" keeps every word of it.
 */
const LEAD_INS = [
  /^(my|the)\s+(name|address|number|phone|location)\s+is[:,\s]+/i,
  /^(it'?s|its|this is|that'?s)[:,\s]+/i,
  /^(send|deliver|bring)\s+(it\s+)?to[:,\s]+/i,
  /^(name|address|phone|number|location)[:,\s]+/i,
  /^(please|pls|kindly)[,\s]+/i,
];

function stripLeadIns(raw: string): string {
  let text = raw.trim();
  // Twice, because "please, my name is Ama" carries two of them.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const pattern of LEAD_INS) {
      const next = text.replace(pattern, '');
      if (next !== text) {
        text = next.trim();
        break;
      }
    }
  }
  return text;
}

/**
 * A number a rider can actually call.
 *
 * Normalisation is delegated to `utils/phone.ts`, which says of itself that it
 * is the single implementation and previously existed in three places. This is
 * not going to be the fourth. What is added here is a judgement that module
 * deliberately does not make: whether the result is worth storing as a
 * callback number.
 *
 * Ghanaian numbers are checked against the real network prefixes, because a
 * rider dialling a number that was never valid wastes a trip, which is worse
 * than having no number and phoning the WhatsApp line we already hold.
 *
 * Foreign numbers are accepted on length alone. A customer in London ordering
 * for family in Accra is an ordinary Friday here, and `normalizeGhanaPhone`
 * already refuses to force a 233 prefix onto them for exactly that reason.
 */
const GH_MOBILE_PREFIXES = new Set([
  '20', '23', '24', '25', '26', '27', '28', '50', '53', '54', '55', '56', '57', '59',
]);

/** E.164 allows at most 15 digits; below 9 nothing is a dialable number. */
const MIN_PHONE_DIGITS = 9;
const MAX_PHONE_DIGITS = 15;

export function parseContactPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;

  const normalised = normalizeGhanaPhone(raw);

  if (isGhanaPhone(normalised)) {
    return GH_MOBILE_PREFIXES.has(normalised.slice(3, 5)) ? normalised : null;
  }

  return normalised.length >= MIN_PHONE_DIGITS ? normalised : null;
}

/** The first thing still missing, or null when there is nothing left to ask. */
export function nextMissingField(state: DeliveryDetails): DeliveryField | null {
  for (const field of DELIVERY_FIELDS) {
    if (!state[field]) return field;
  }
  return null;
}

export function isComplete(state: DeliveryDetails): boolean {
  return nextMissingField(state) === null;
}

/**
 * Turns a reply into a storable value, or null when it cannot be one.
 *
 * Returning null is a real outcome, not an error: it means "ask again", which
 * is what the caller does.
 */
export function parseAnswer(field: DeliveryField, body: string): string | null {
  const text = stripLeadIns(body).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;

  switch (field) {
    case 'contactPhone':
      return parseContactPhone(text);

    case 'recipientName': {
      if (text.length > MAX_NAME_LENGTH) return null;
      // A name with no letters in it is a phone number, an emoji or a mistake.
      if (!/\p{L}/u.test(text)) return null;
      return text;
    }

    case 'deliveryAddress': {
      if (text.length > MAX_FIELD_LENGTH) return null;
      // An address needs to be more than an acknowledgement. "ok", "yes" and
      // "send it" are the commonest non-answers here.
      if (text.length < 5) return null;
      if (/^(ok(ay)?|yes|yep|sure|fine|send it|go ahead)$/i.test(text)) return null;
      return text;
    }

    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** Formats a stored 233XXXXXXXXX back into something a person reads easily. */
export function displayPhone(stored: string): string {
  if (/^233\d{9}$/.test(stored)) {
    const n = stored.slice(3);
    return `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
  }
  return stored;
}

export interface QuestionInput {
  profile: BusinessProfile | null;
  /** Which attempt this is, so a re-ask can be phrased differently. */
  reasked?: boolean;
}

/**
 * The question for one missing field.
 *
 * One at a time. A single message asking for name, address and phone reads as a
 * form, and on WhatsApp it reliably gets one of the three answered.
 */
export function composeQuestion(
  field: DeliveryField,
  input: QuestionInput = { profile: null },
): string {
  const { reasked } = input;

  switch (field) {
    case 'recipientName':
      return reasked
        ? 'Sorry, I did not catch the name. Who should we put on the delivery?'
        : 'Almost done. Who should we put on the delivery?';

    case 'deliveryAddress': {
      const areas = input.profile?.deliveryAreas ?? [];
      if (reasked) {
        return 'I need a bit more than that. What is the full delivery address, including a landmark if you have one?';
      }
      if (areas.length === 0) return 'What is the delivery address?';
      const shown = areas.slice(0, 6).join(', ');
      return `What is the delivery address? We cover ${shown}.`;
    }

    case 'contactPhone':
      return reasked
        ? 'That number did not look right. What is the best number to call on delivery? Something like 024 123 4567.'
        : 'And a number to call when we arrive?';

    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/**
 * The one-message version, for a customer who has ordered before.
 *
 * Shows everything we already hold and asks for a yes. Three round trips become
 * one for anyone who is not moving house between orders.
 */
export function composeConfirmation(known: DeliveryDetails): string | null {
  if (!isComplete(known)) return null;
  return (
    `Delivering to ${known.recipientName}, ${known.deliveryAddress}, ` +
    `${displayPhone(known.contactPhone!)}. Is that still right? ` +
    'Reply YES to confirm, or send the new address.'
  );
}

const AFFIRMATIVE =
  /^(y|ye|yes|yeah|yep|yh|ok|okay|correct|right|same|sure|confirm(ed)?|that'?s right|still right)[.!]?$/i;

/** Whether a reply to `composeConfirmation` is a yes. */
export function isAffirmative(body: string): boolean {
  return AFFIRMATIVE.test(body.trim());
}
