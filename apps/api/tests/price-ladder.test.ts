import { describe, expect, it } from 'vitest';
import {
  buildLadder,
  offerIsAuthorised,
  promotionIsLive,
  unitPriceForQuantity,
} from '../src/services/pricing/ladder.js';

/**
 * The floor is the only thing standing between a negotiating assistant and a
 * shop that sold its stock at a loss. These tests are the floor's proof.
 */
describe('price ladder', () => {
  const base = { price: 50, bargainingEnabled: true };

  it('is one rung when nothing is set', () => {
    const ladder = buildLadder({ price: 50, bargainingEnabled: false });
    expect(ladder.rungs).toEqual([50]);
    expect(ladder.floor).toBeNull();
  });

  it('refuses every discount when the shop has not enabled bargaining', () => {
    const ladder = buildLadder({ price: 50, floorPrice: 40, bargainingEnabled: false });
    expect(ladder.floor).toBeNull();
    expect(offerIsAuthorised(ladder, 1, 49.99)).toBe(false);
    expect(offerIsAuthorised(ladder, 1, 50)).toBe(true);
  });

  it('refuses every discount when the product has no floor', () => {
    const ladder = buildLadder({ ...base, floorPrice: null });
    expect(offerIsAuthorised(ladder, 1, 49)).toBe(false);
  });

  it('allows exactly the floor and nothing under it', () => {
    const ladder = buildLadder({ ...base, floorPrice: 40 });
    expect(offerIsAuthorised(ladder, 1, 40)).toBe(true);
    expect(offerIsAuthorised(ladder, 1, 39.99)).toBe(false);
    expect(offerIsAuthorised(ladder, 1, 0)).toBe(false);
    expect(offerIsAuthorised(ladder, 1, -5)).toBe(false);
  });

  it('compares in pesewas, so a floor with decimals is not a float rounding loss', () => {
    // 40.30 as a float is 40.299999999999997. A naive >= comparison against the
    // same number computed a different way rejects the shop's own floor.
    const ladder = buildLadder({ ...base, price: 100.1, floorPrice: 40.3 });
    expect(offerIsAuthorised(ladder, 1, 40.3)).toBe(true);
    expect(offerIsAuthorised(ladder, 1, 40.29)).toBe(false);
  });

  it('never rejects a customer offering to pay more', () => {
    const ladder = buildLadder({ ...base, floorPrice: 40 });
    expect(offerIsAuthorised(ladder, 1, 60)).toBe(true);
  });
});

describe('promotions', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('is not live without a percentage', () => {
    expect(promotionIsLive(null, null, now)).toBe(false);
  });

  it('is not live once the expiry has passed', () => {
    expect(promotionIsLive(20, new Date('2026-09-17T11:59:59Z'), now)).toBe(false);
    expect(promotionIsLive(20, new Date('2026-09-17T12:00:01Z'), now)).toBe(true);
  });

  it('rejects a percentage outside 1-90, so nothing is ever free', () => {
    expect(promotionIsLive(0, null, now)).toBe(false);
    expect(promotionIsLive(91, null, now)).toBe(false);
    expect(promotionIsLive(100, null, now)).toBe(false);
  });

  it('rounds the discount down, never up', () => {
    // 33% off 10.00 is 6.70 exactly; 33% off 10.05 is 6.7335, which must not
    // become 6.74 — the customer was promised a third off and can check.
    const ladder = buildLadder(
      { price: 10.05, discountPercent: 33, bargainingEnabled: false },
      now,
    );
    expect(ladder.promoPrice).toBe(6.73);
  });

  it('carries the label only while it is live', () => {
    const live = buildLadder(
      {
        price: 50,
        discountPercent: 20,
        discountLabel: 'Flash Sale',
        discountEndsAt: new Date('2026-09-18T00:00:00Z'),
        bargainingEnabled: false,
      },
      now,
    );
    expect(live.promoLabel).toBe('Flash Sale');
    expect(live.promoPrice).toBe(40);

    const expired = buildLadder(
      {
        price: 50,
        discountPercent: 20,
        discountLabel: 'Flash Sale',
        discountEndsAt: new Date('2026-09-16T00:00:00Z'),
        bargainingEnabled: false,
      },
      now,
    );
    expect(expired.promoLabel).toBeNull();
    expect(expired.promoPrice).toBe(50);
  });
});

describe('quantity tiers', () => {
  const tiers = [
    { minQuantity: 10, percentOff: 12 },
    { minQuantity: 5, percentOff: 5 },
  ];

  it('applies the deepest tier the quantity has earned, whatever order they were given in', () => {
    const ladder = buildLadder({ price: 100, tiers, bargainingEnabled: false });
    expect(unitPriceForQuantity(ladder, 1)).toBe(100);
    expect(unitPriceForQuantity(ladder, 4)).toBe(100);
    expect(unitPriceForQuantity(ladder, 5)).toBe(95);
    expect(unitPriceForQuantity(ladder, 9)).toBe(95);
    expect(unitPriceForQuantity(ladder, 10)).toBe(88);
    expect(unitPriceForQuantity(ladder, 1000)).toBe(88);
  });

  it('compounds with a live promotion, because the owner turned both on', () => {
    const ladder = buildLadder({
      price: 100,
      discountPercent: 10,
      tiers: [{ minQuantity: 5, percentOff: 10 }],
      bargainingEnabled: false,
    });
    expect(ladder.promoPrice).toBe(90);
    expect(unitPriceForQuantity(ladder, 5)).toBe(81);
  });

  it('drops a tier the database constraint would have refused', () => {
    const ladder = buildLadder({
      price: 100,
      tiers: [
        { minQuantity: 1, percentOff: 50 },
        { minQuantity: 5, percentOff: 99 },
        { minQuantity: 10, percentOff: 10 },
      ],
      bargainingEnabled: false,
    });
    expect(ladder.tiers.map((t) => t.minQuantity)).toEqual([10]);
    expect(unitPriceForQuantity(ladder, 6)).toBe(100);
  });

  it('measures an offer against the tier price, not the list price', () => {
    const ladder = buildLadder({ price: 100, floorPrice: 80, tiers, bargainingEnabled: true });
    // At ten units the standard price is already 88, so 88 is not a discount.
    expect(offerIsAuthorised(ladder, 10, 88)).toBe(true);
    expect(offerIsAuthorised(ladder, 10, 80)).toBe(true);
    expect(offerIsAuthorised(ladder, 10, 79.99)).toBe(false);
  });
});

describe('the floor against everything else', () => {
  it('is pulled down to the promotion when the promotion is deeper', () => {
    // Floor 45, but a 50% promotion puts the price at 25. A floor of 45 would
    // mean "negotiation" could only ever raise the price back up, which is not
    // what an owner running a sale means.
    const ladder = buildLadder({
      price: 50,
      floorPrice: 45,
      discountPercent: 50,
      bargainingEnabled: true,
    });
    expect(ladder.promoPrice).toBe(25);
    expect(ladder.floor).toBe(25);
    expect(offerIsAuthorised(ladder, 1, 25)).toBe(true);
    expect(offerIsAuthorised(ladder, 1, 24.99)).toBe(false);
  });

  it('is pulled down to the deepest tier price', () => {
    const ladder = buildLadder({
      price: 100,
      floorPrice: 95,
      tiers: [{ minQuantity: 10, percentOff: 20 }],
      bargainingEnabled: true,
    });
    expect(ladder.floor).toBe(80);
  });

  it('lists every rung and nothing between them', () => {
    const ladder = buildLadder({
      price: 100,
      floorPrice: 70,
      discountPercent: 10,
      tiers: [{ minQuantity: 5, percentOff: 10 }],
      bargainingEnabled: true,
    });
    expect(ladder.rungs).toEqual([70, 81, 90, 100]);
  });
});
