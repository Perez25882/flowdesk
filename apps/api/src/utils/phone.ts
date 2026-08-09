/**
 * Ghanaian phone number normalisation.
 *
 * Every number entering the system is reduced to the WhatsApp wire format —
 * country code, no plus, no separators (e.g. `233241234567`). Customers are
 * keyed on this value, so inconsistent normalisation silently creates duplicate
 * customer records for the same person.
 *
 * This module is the single implementation; it previously existed in three
 * places with subtly different rules.
 */

const GHANA_COUNTRY_CODE = '233';
/** National subscriber number length in Ghana, excluding the trunk '0'. */
const GHANA_SUBSCRIBER_DIGITS = 9;

/**
 * Reduces any written form of a Ghanaian number to `233XXXXXXXXX`.
 *
 * Handles the local trunk form (`024...`), the bare subscriber form (`24...`),
 * and numbers already carrying the country code, with or without `+`, spaces,
 * dashes or parentheses.
 *
 * International (non-Ghanaian) numbers are returned digits-only and unchanged —
 * diaspora customers are common and must not be rewritten into invalid Ghanaian
 * numbers.
 */
export function normalizeGhanaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 0) {
    return '';
  }

  // Already in country-code form.
  if (digits.startsWith(GHANA_COUNTRY_CODE) && digits.length === GHANA_COUNTRY_CODE.length + GHANA_SUBSCRIBER_DIGITS) {
    return digits;
  }

  // Local trunk form: 0XXXXXXXXX -> 233XXXXXXXXX
  if (digits.startsWith('0') && digits.length === GHANA_SUBSCRIBER_DIGITS + 1) {
    return `${GHANA_COUNTRY_CODE}${digits.slice(1)}`;
  }

  // Bare subscriber number: XXXXXXXXX -> 233XXXXXXXXX
  if (digits.length === GHANA_SUBSCRIBER_DIGITS) {
    return `${GHANA_COUNTRY_CODE}${digits}`;
  }

  // Anything else is a foreign number (or malformed). Return the digits as-is
  // rather than forcing a Ghanaian prefix onto it.
  return digits;
}

/** True when the value is a well-formed Ghanaian number in wire format. */
export function isGhanaPhone(value: string): boolean {
  return new RegExp(`^${GHANA_COUNTRY_CODE}\\d{${GHANA_SUBSCRIBER_DIGITS}}$`).test(value);
}

/**
 * Masks a phone number for logs. PII must not appear in log aggregation, but
 * enough of the number is kept to correlate entries during support.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '(none)';
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-3)}`;
}
