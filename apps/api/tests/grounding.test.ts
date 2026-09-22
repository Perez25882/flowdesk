import { describe, expect, it } from 'vitest';
import { buildEvidenceSet, type EvidenceProduct } from '../src/services/assistant/evidence.js';
import { assertsCheckableFact, typeNumbers, validateGrounding } from '../src/services/assistant/grounding.js';

/**
 * The guardrail that stands between the model and a customer.
 *
 * Two failure modes matter equally:
 *
 *   Letting a wrong price through — a confidently stated figure the shop never
 *   charges, which costs the owner money or trust.
 *
 *   Rejecting a right one — if legitimate answers fail, every reply becomes a
 *   draft and the feature quietly does nothing while appearing to work.
 *
 * The second is the easier mistake to make, so most of these tests are about
 * numbers that MUST be allowed through.
 */

const products: EvidenceProduct[] = [
  { id: 'p_rice5', name: 'Rice 5kg', unit: 'bag', price: 80, stockQuantity: 12 },
  { id: 'p_malta', name: 'Malta Guinness 33cl', unit: 'bottle', price: 12.5, stockQuantity: 0 },
];

function evidence(opts: { quantities?: number[] } = {}) {
  return buildEvidenceSet({
    products,
    profile: {
      deliveryFee: 20,
      minimumOrder: 50,
      openingHours: { days: ['mon'], opensAt: '08:00', closesAt: '18:00' },
    },
    openOrders: [
      {
        id: 'o_1',
        referenceNumber: 'FD-00042',
        status: 'CONFIRMED',
        totalAmount: 160,
        amountPaid: 60,
      },
    ],
    mentionedQuantities: opts.quantities ?? [],
    businessPhones: ['+233 24 400 0111'],
  });
}

function check(text: string, opts: { grounded?: string[]; stock?: number[]; quantities?: number[] } = {}) {
  return validateGrounding({
    text,
    evidence: evidence({ quantities: opts.quantities ?? [] }),
    groundedOn: opts.grounded ?? ['product:p_rice5'],
    citedStock: opts.stock ?? [12],
  });
}

describe('typeNumbers', () => {
  it('reads a price as currency either side of the symbol', () => {
    expect(typeNumbers('GHS 80')).toContainEqual({ value: 80, kind: 'currency' });
    expect(typeNumbers('80 cedis')).toContainEqual({ value: 80, kind: 'currency' });
    expect(typeNumbers('₵80')).toContainEqual({ value: 80, kind: 'currency' });
  });

  it('reads a spelled-out price', () => {
    expect(typeNumbers('fifty cedis')).toContainEqual({ value: 50, kind: 'currency' });
  });

  it('does not mistake a closing time for money', () => {
    const kinds = typeNumbers('We close at 6pm').map((n) => n.kind);
    expect(kinds).toContain('time');
    expect(kinds).not.toContain('currency');
  });

  it('does not mistake a pack size for money', () => {
    const kinds = typeNumbers('The 33cl bottle').map((n) => n.kind);
    expect(kinds).toContain('pack_size');
    expect(kinds).not.toContain('currency');
  });

  it('does not mistake a plain quantity for money', () => {
    const kinds = typeNumbers('2 bags').map((n) => n.kind);
    expect(kinds).not.toContain('currency');
  });

  it('does not mistake the customer’s own quantity for a stock level', () => {
    // A unit noun after a number says what is being counted, not how many the
    // shop holds. Reading "2 bags" as a stock claim rejected the correct answer
    // to "how much for 2 bags?", because 2 is not one of the catalogue's counts.
    for (const text of ['2 bags', '3 bottles', '4 pieces', '5 units']) {
      expect(typeNumbers(text).map((n) => n.kind), text).not.toContain('stock');
    }
  });

  it('still reads a real stock claim as one', () => {
    for (const text of ['we have 3 left', 'only 4 remaining', 'there are 5 in stock']) {
      expect(typeNumbers(text).map((n) => n.kind), text).toContain('stock');
    }
  });

  it('ignores long digit runs, which are identifiers not quantities', () => {
    expect(typeNumbers('call 0244000111')).toHaveLength(0);
  });
});

describe('validateGrounding — must ALLOW correct answers', () => {
  it('a price straight from the catalogue', () => {
    expect(check('Rice 5kg is GHS 80.').ok).toBe(true);
  });

  it('a subtotal stated with the unit the customer used', () => {
    // Regression: "2 bags" was read as a stock claim, so the whole answer was
    // rejected over a number that was never a stock claim at all.
    const result = check('2 bags of Rice 5kg is GHS 160.', { quantities: [2] });
    expect(result.failures).not.toContain('unverified_stock_claim');
    expect(result.ok).toBe(true);
  });

  it('a computed subtotal that appears in no row', () => {
    // The single most common correct answer to "how much for 2?" — and it is
    // in no database row, so it has to be derived.
    expect(check('Two bags come to GHS 160.', { quantities: [2] }).ok).toBe(true);
  });

  it('opening hours', () => {
    expect(check('We open at 8am and close at 6pm.').ok).toBe(true);
  });

  it('a delivery fee from the profile', () => {
    expect(check('Delivery is GHS 20.').ok).toBe(true);
  });

  it('an outstanding balance derived from an order', () => {
    // 160 total less 60 paid. Stated nowhere, correct nonetheless.
    expect(check('You have GHS 100 left to pay on FD-00042.').ok).toBe(true);
  });

  it('a quantity next to a pack size', () => {
    expect(check('Yes, we have the 33cl bottles.', { stock: [12] }).ok).toBe(true);
  });

  it('the business quoting its own phone number', () => {
    expect(check('Call us on 0244000111.').ok).toBe(true);
  });

  it('zero, for "no charge"', () => {
    expect(check('Delivery is GHS 0 for you.').ok).toBe(true);
  });
});

describe('validateGrounding — must BLOCK wrong or unsafe answers', () => {
  it('a price the shop does not charge', () => {
    const result = check('Rice 5kg is GHS 45.');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unverified_amount');
  });

  it('a subtotal for a quantity nobody mentioned', () => {
    const result = check('That comes to GHS 400.');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unverified_amount');
  });

  it('claiming stock for something out of stock, with no number at all', () => {
    // The affirmation check exists precisely because this text contains
    // nothing for a numeric test to catch.
    const result = check('Yes, we have it in stock.', {
      grounded: ['product:p_malta'],
      stock: [0],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('availability_contradicts_stock');
  });

  it('a stock count that is not real', () => {
    const result = check('We have 99 left.');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unverified_stock_claim');
  });

  it('an order reference belonging to someone else', () => {
    const result = check('Your order FD-99999 is on the way.');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unknown_order_reference');
  });

  it("someone else's phone number", () => {
    // The exploit this closes: using a shop's assistant to relay a stranger's
    // MoMo number to its customers.
    const result = check('Send the money to 0501234567.');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('foreign_phone_number');
  });

  it('a link', () => {
    const result = check('Pay here: https://not-your-shop.example/pay');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('contains_url');
  });

  it('an email address', () => {
    const result = check('Email us at someone@elsewhere.example');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('contains_email');
  });

  it('an answer resting on no evidence at all', () => {
    const result = check('Sure, that should be fine.', { grounded: [] });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('ungrounded_claim');
  });

  it('empty text', () => {
    expect(check('   ').failures).toEqual(['empty']);
  });

  it('reports every problem, not just the first', () => {
    const result = check('Pay GHS 45 to 0501234567 at https://x.example', { grounded: [] });
    expect(result.failures.length).toBeGreaterThan(2);
  });
});

describe('evidence set', () => {
  it('derives totals only for quantities the customer named', () => {
    const withThree = buildEvidenceSet({
      products,
      profile: null,
      openOrders: [],
      mentionedQuantities: [3],
      businessPhones: [],
    });

    expect(withThree.allowedAmounts.has(24_000)).toBe(true); // 3 × 80
    expect(withThree.allowedAmounts.has(32_000)).toBe(false); // 4 × 80, unasked
  });

  it('always allows the unit price', () => {
    const set = buildEvidenceSet({
      products,
      profile: null,
      openOrders: [],
      mentionedQuantities: [],
      businessPhones: [],
    });

    expect(set.allowedAmounts.has(8_000)).toBe(true);
  });

  it('handles fractional prices without float drift', () => {
    // 12.5 × 2 = 25.00 exactly, not 24.999999999999996.
    const set = buildEvidenceSet({
      products,
      profile: null,
      openOrders: [],
      mentionedQuantities: [2],
      businessPhones: [],
    });

    expect(set.allowedAmounts.has(2_500)).toBe(true);
  });

  it('records which facts were actually supplied', () => {
    const set = buildEvidenceSet({
      products: [],
      profile: { deliveryFee: 20 },
      openOrders: [],
      mentionedQuantities: [],
      businessPhones: [],
    });

    expect(set.factKeys.has('deliveryFee')).toBe(true);
    expect(set.factKeys.has('minimumOrder')).toBe(false);
  });
});

describe('assertsCheckableFact — what actually needs evidence', () => {
  it('a bare greeting claims nothing', () => {
    expect(assertsCheckableFact('Morning! How can I help you today?')).toBe(false);
    expect(assertsCheckableFact('You welcome!')).toBe(false);
    expect(assertsCheckableFact('Ah wo ho te sen?')).toBe(false);
  });

  it('a price is a claim even inside a friendly sentence', () => {
    expect(assertsCheckableFact('Morning! The rice is GHS 620 a bag.')).toBe(true);
  });

  it('an availability affirmation is a claim with no number in it', () => {
    expect(assertsCheckableFact('Yes we have it, come through')).toBe(true);
  });

  it('an order reference is a claim', () => {
    expect(assertsCheckableFact('Your order FD-00042 is on the way')).toBe(true);
  });

  /**
   * Reversed deliberately: a digit is now a claim, quantity included.
   *
   * The old rule looked only for money, stock and order references, and a real
   * customer found the hole. Asked "what time do you open?" for a shop with no
   * opening hours on file, the model answered "We open at 8am" — no currency, no
   * stock count, so it read as claim-free and would have gone out unread. A
   * wrong opening time costs a shop a morning of customers at a closed door.
   *
   * Enumerating times, then dates, then weights, then delivery fees is a losing
   * game, so the line moved to where it can hold: a digit is the shop asserting
   * something specific, and specifics need a row behind them. The cost is that a
   * quantity echoed back now needs a citation too — cheap, because quantities the
   * customer wrote are already in the evidence set, and anything order-shaped
   * goes to the owner regardless.
   *
   * Replies with nothing to verify carry no digits and are untouched, which is
   * what keeps greetings and "we don't sell that" answering instantly.
   */
  it('treats any digit as a claim, quantities included', () => {
    expect(assertsCheckableFact('Ok, 2 of them, see you tomorrow')).toBe(true);
  });

  it('still reads a sentence with no figures in it as claim-free', () => {
    expect(assertsCheckableFact('Ok, see you tomorrow')).toBe(false);
  });
});

describe('requireCitation — the narrow exception', () => {
  it('still blocks an uncited commitment by default', () => {
    const result = check('Sure, that should be fine.', { grounded: [] });
    expect(result.failures).toContain('ungrounded_claim');
  });

  it('lets a pleasantry through when the caller clears it', () => {
    const result = validateGrounding({
      text: 'Morning! How can I help you today?',
      evidence: buildEvidenceSet({
        products: [],
        profile: null,
        openOrders: [],
        mentionedQuantities: [],
        businessPhones: [],
      }),
      groundedOn: [],
      citedStock: [],
      requireCitation: false,
    });
    expect(result.ok).toBe(true);
  });
});
