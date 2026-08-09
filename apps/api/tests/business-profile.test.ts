import { describe, expect, it } from 'vitest';
import {
  countAnsweredQuestions,
  hasGroundableFacts,
  isProfileEmpty,
  PROFILE_QUESTIONS,
  type BusinessProfile,
} from '@flowdesk/shared';
import { mergeBusinessProfile } from '../src/modules/settings/settings.route.js';
import { BusinessProfileSchema } from '../src/modules/settings/settings.schema.js';

/**
 * The business profile is what lets the assistant answer "do you deliver to
 * Tema?" instead of "please share more details". Two things must hold: saving
 * one section must not erase another, and a value that reaches a customer must
 * have been validated on the way in.
 */
describe('mergeBusinessProfile', () => {
  it('keeps answers the current request did not mention', () => {
    // The wizard saves a section at a time. Assigning the JSON column outright
    // would drop everything not in this particular payload.
    const stored = { deliveryAreas: ['Tema'], minimumOrder: 50 };

    expect(mergeBusinessProfile(stored, { paymentMethods: ['MOMO_MTN'] })).toEqual({
      deliveryAreas: ['Tema'],
      minimumOrder: 50,
      paymentMethods: ['MOMO_MTN'],
    });
  });

  it('overwrites a field that is sent again', () => {
    expect(mergeBusinessProfile({ minimumOrder: 50 }, { minimumOrder: 100 })).toEqual({
      minimumOrder: 100,
    });
  });

  it('preserves an explicit null — "asked, and the answer is none"', () => {
    // Distinct from a key that was never sent, which must leave the stored
    // value alone.
    expect(mergeBusinessProfile({ deliveryFee: 20 }, { deliveryFee: null })).toEqual({
      deliveryFee: null,
    });
  });

  it('ignores keys explicitly set to undefined', () => {
    expect(mergeBusinessProfile({ minimumOrder: 50 }, { minimumOrder: undefined })).toEqual({
      minimumOrder: 50,
    });
  });

  it('clears the whole profile when the patch itself is null', () => {
    expect(mergeBusinessProfile({ minimumOrder: 50 }, null)).toBeNull();
  });

  it('starts from empty when nothing is stored, or the column holds junk', () => {
    expect(mergeBusinessProfile(null, { minimumOrder: 50 })).toEqual({ minimumOrder: 50 });
    expect(mergeBusinessProfile('not-an-object', { minimumOrder: 50 })).toEqual({
      minimumOrder: 50,
    });
    expect(mergeBusinessProfile(['array'], { minimumOrder: 50 })).toEqual({ minimumOrder: 50 });
  });
});

describe('BusinessProfileSchema', () => {
  it('accepts a fully answered profile', () => {
    const profile: BusinessProfile = {
      openingHours: { days: ['mon', 'sat'], opensAt: '08:00', closesAt: '18:30' },
      deliveryAreas: ['Tema', 'Spintex'],
      deliveryFee: 20,
      freeDeliveryAbove: 200,
      minimumOrder: 50,
      paymentMethods: ['MOMO_MTN', 'CASH'],
      pricingStance: 'SOME_FLEXIBILITY',
      acceptsReturns: true,
      returnWindowDays: 7,
    };

    expect(BusinessProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('accepts an empty profile — the wizard is skippable', () => {
    expect(BusinessProfileSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a time the assistant could not quote correctly', () => {
    for (const bad of ['8am', '25:00', '08:60', '8:00', '']) {
      const result = BusinessProfileSchema.safeParse({
        openingHours: { days: ['mon'], opensAt: bad, closesAt: '18:00' },
      });
      expect(result.success, `${bad} should be rejected`).toBe(false);
    }
  });

  it('rejects an unknown payment method rather than storing it unread', () => {
    expect(
      BusinessProfileSchema.safeParse({ paymentMethods: ['BITCOIN'] }).success,
    ).toBe(false);
  });

  it('rejects unknown keys so a typo cannot be silently persisted', () => {
    expect(BusinessProfileSchema.safeParse({ deliveryArea: ['Tema'] }).success).toBe(false);
  });

  it('rejects a negative or absurd fee', () => {
    expect(BusinessProfileSchema.safeParse({ deliveryFee: -5 }).success).toBe(false);
    expect(BusinessProfileSchema.safeParse({ deliveryFee: 99_999_999 }).success).toBe(false);
  });

  it('allows null for "no delivery fee"', () => {
    expect(BusinessProfileSchema.safeParse({ deliveryFee: null }).success).toBe(true);
  });
});

describe('profile completeness helpers', () => {
  it('treats absent, empty, and all-empty-array profiles as empty', () => {
    expect(isProfileEmpty(null)).toBe(true);
    expect(isProfileEmpty(undefined)).toBe(true);
    expect(isProfileEmpty({})).toBe(true);
    expect(isProfileEmpty({ deliveryAreas: [] })).toBe(true);
  });

  it('counts only questions that actually have an answer', () => {
    expect(countAnsweredQuestions({})).toBe(0);
    expect(countAnsweredQuestions({ deliveryAreas: [] })).toBe(0);
    expect(countAnsweredQuestions({ deliveryAreas: ['Tema'] })).toBe(1);
    expect(countAnsweredQuestions({ deliveryAreas: ['Tema'], minimumOrder: 50 })).toBe(2);
  });

  it('does not count opening hours with no days selected', () => {
    expect(
      countAnsweredQuestions({ openingHours: { days: [], opensAt: '08:00', closesAt: '18:00' } }),
    ).toBe(0);
  });

  it('counts a deliberate "none" answer as answered', () => {
    // Saying "we charge nothing for delivery" is information the assistant can
    // use, so it must not read as an unanswered question.
    expect(countAnsweredQuestions({ deliveryFee: 0 })).toBe(1);
    expect(countAnsweredQuestions({ acceptsReturns: false })).toBe(1);
  });

  it('withholds auto-send until at least one fact exists', () => {
    // A shop that skipped setup has nothing to check an answer against, so it
    // stays in draft mode however it is configured.
    expect(hasGroundableFacts(null)).toBe(false);
    expect(hasGroundableFacts({})).toBe(false);
    expect(hasGroundableFacts({ deliveryAreas: ['Tema'] })).toBe(true);
  });

  it('asks every question exactly once', () => {
    const fields = PROFILE_QUESTIONS.map((q) => q.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
