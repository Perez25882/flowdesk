import { describe, expect, it } from 'vitest';
import { isGhanaPhone, maskPhone, normalizeGhanaPhone } from '../src/utils/phone.js';

/**
 * Customers are keyed on the normalised number, so any inconsistency here
 * silently creates a duplicate customer record for the same person — and splits
 * their order history and outstanding balance across both.
 */
describe('normalizeGhanaPhone', () => {
  it('maps every written form of one number to the same value', () => {
    const expected = '233241234567';

    for (const input of [
      '0241234567',
      '241234567',
      '233241234567',
      '+233241234567',
      '+233 24 123 4567',
      '024-123-4567',
      '(024) 123 4567',
      ' 0241234567 ',
    ]) {
      expect(normalizeGhanaPhone(input), `input: ${input}`).toBe(expected);
    }
  });

  it('leaves international numbers alone rather than forcing a Ghana prefix', () => {
    // Diaspora customers are common; rewriting a UK number as Ghanaian would
    // make it permanently unreachable.
    expect(normalizeGhanaPhone('+44 7700 900123')).toBe('447700900123');
    expect(normalizeGhanaPhone('+1 415 555 0100')).toBe('14155550100');
  });

  it('returns an empty string when there are no digits', () => {
    expect(normalizeGhanaPhone('')).toBe('');
    expect(normalizeGhanaPhone('not a phone')).toBe('');
  });
});

describe('isGhanaPhone', () => {
  it('accepts a normalised Ghanaian number', () => {
    expect(isGhanaPhone('233241234567')).toBe(true);
  });

  it('rejects wrong lengths and un-normalised forms', () => {
    expect(isGhanaPhone('0241234567')).toBe(false);
    expect(isGhanaPhone('23324123456')).toBe(false);
    expect(isGhanaPhone('2332412345678')).toBe(false);
    expect(isGhanaPhone('447700900123')).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps enough digits to correlate log entries without exposing the number', () => {
    const masked = maskPhone('233241234567');

    expect(masked.startsWith('233')).toBe(true);
    expect(masked.endsWith('567')).toBe(true);
    expect(masked).not.toContain('2412');
  });

  it('handles absent and very short values', () => {
    expect(maskPhone(null)).toBe('(none)');
    expect(maskPhone(undefined)).toBe('(none)');
    expect(maskPhone('12')).toBe('**');
  });
});
