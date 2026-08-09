import { describe, expect, it } from 'vitest';
import { extractItemsFromText, type CatalogProduct } from '../src/utils/item-extractor.js';

/**
 * The catalog mirrors the PRD's worked examples (Abena's grocery distribution
 * business) so these tests double as acceptance criteria for the product's
 * headline demo: a customer types a normal WhatsApp sentence and a priced
 * order appears.
 */
const catalog: CatalogProduct[] = [
  {
    id: 'rice50',
    name: 'Rice 50kg',
    aliases: ['rice', '50kg rice', 'big rice', 'bag of rice'],
    unit: 'bag',
    price: 450,
  },
  {
    id: 'rice25',
    name: 'Rice 25kg',
    aliases: ['small rice', '25kg rice'],
    unit: 'bag',
    price: 240,
  },
  {
    id: 'malta',
    name: 'Malta Guinness 33cl',
    aliases: ['malta', 'malt', 'small malta'],
    unit: 'bottle',
    price: 5.5,
  },
  {
    id: 'oil',
    name: 'Frytol Cooking Oil 5L',
    aliases: ['oil', 'frytol', 'cooking oil'],
    unit: 'gallon',
    price: 120,
  },
  {
    id: 'water',
    name: 'Voltic Water 750ml',
    aliases: ['water', 'voltic'],
    unit: 'pack',
    price: 15,
  },
];

function only(text: string) {
  const items = extractItemsFromText(text, catalog);
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('extractItemsFromText — quantity parsing', () => {
  it('does not mistake a number inside the product name for a quantity', () => {
    const item = only('Rice 50kg');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(1);
  });

  it('reads the leading quantity when the product name also contains digits', () => {
    const item = only('I want 2 bags of rice 50kg');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(2);
  });

  it('parses spelled-out number words', () => {
    const item = only('please send three bags of rice');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(3);
  });

  it('parses the x3 multiplier form', () => {
    const item = only('malta x3');

    expect(item.productId).toBe('malta');
    expect(item.quantity).toBe(3);
  });

  it('parses the 3x multiplier form', () => {
    const item = only('3x malta');

    expect(item.productId).toBe('malta');
    expect(item.quantity).toBe(3);
  });

  it('parses a quantity written flush against the unit', () => {
    const item = only('I need 3bags of rice');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(3);
  });

  it('defaults to a quantity of one when none is stated', () => {
    const item = only('send me malta');

    expect(item.quantity).toBe(1);
  });

  it('handles fractional quantities', () => {
    const item = only('half bag of rice');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(0.5);
  });
});

describe('extractItemsFromText — product matching', () => {
  it('matches an alias appearing mid-sentence', () => {
    const item = only('i want 24 malta');

    expect(item.productId).toBe('malta');
    expect(item.quantity).toBe(24);
    expect(item.unitPrice).toBe(5.5);
    expect(item.matched).toBe(true);
  });

  it('prefers the most specific product when names overlap', () => {
    const item = only('give me 2 small rice');

    expect(item.productId).toBe('rice25');
  });

  it('falls back to the general product when no qualifier is given', () => {
    const item = only('2 bags of rice');

    expect(item.productId).toBe('rice50');
  });

  it('prices the line from the catalog', () => {
    const item = only('4 bags of rice 50kg');

    expect(item.unitPrice).toBe(450);
    expect(item.quantity).toBe(4);
  });

  it('is case insensitive', () => {
    const item = only('RICE 50KG');

    expect(item.productId).toBe('rice50');
  });

  it('tolerates minor misspellings', () => {
    const item = only('2 bags of ric');

    expect(item.productId).toBe('rice50');
  });

  it('records an unmatched item rather than dropping it', () => {
    const item = only('5 crates of tomatoes');

    expect(item.matched).toBe(false);
    expect(item.productId).toBeNull();
    expect(item.unitPrice).toBe(0);
    expect(item.quantity).toBe(5);
    expect(item.description).toContain('tomato');
  });
});

describe('extractItemsFromText — multi-item messages', () => {
  it('splits on the word "and"', () => {
    const items = extractItemsFromText('2 bags rice and 12 malta', catalog);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ productId: 'rice50', quantity: 2 });
    expect(items[1]).toMatchObject({ productId: 'malta', quantity: 12 });
  });

  it('splits on commas', () => {
    const items = extractItemsFromText('3 rice, 2 oil, 10 water', catalog);

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.productId)).toEqual(['rice50', 'oil', 'water']);
    expect(items.map((i) => i.quantity)).toEqual([3, 2, 10]);
  });

  it('splits on newlines', () => {
    const items = extractItemsFromText('2 rice\n5 malta', catalog);

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.quantity)).toEqual([2, 5]);
  });

  it('splits on a plus sign', () => {
    const items = extractItemsFromText('1 oil + 2 water', catalog);

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.productId)).toEqual(['oil', 'water']);
  });
});

describe('extractItemsFromText — Ghanaian phrasing', () => {
  it('handles pidgin ordering phrases', () => {
    const item = only('abeg make I get 5 bags of rice');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(5);
  });

  it('handles a chale-prefixed request', () => {
    const item = only('chale i need 2 malta ooo');

    expect(item.productId).toBe('malta');
    expect(item.quantity).toBe(2);
  });

  it('handles common abbreviations', () => {
    const item = only('pls send 3 water');

    expect(item.productId).toBe('water');
    expect(item.quantity).toBe(3);
  });
});

describe('extractItemsFromText — edge cases', () => {
  it('returns nothing for empty input', () => {
    expect(extractItemsFromText('', catalog)).toEqual([]);
    expect(extractItemsFromText('   ', catalog)).toEqual([]);
  });

  it('returns an unmatched line when the catalog is empty', () => {
    const items = extractItemsFromText('2 bags of rice', []);

    expect(items).toHaveLength(1);
    expect(items[0]!.matched).toBe(false);
    expect(items[0]!.quantity).toBe(2);
  });

  it('never returns a non-positive quantity', () => {
    for (const text of ['0 rice', '-3 rice', 'rice']) {
      const items = extractItemsFromText(text, catalog);
      for (const item of items) {
        expect(item.quantity).toBeGreaterThan(0);
      }
    }
  });

  it('caps absurd quantities instead of accepting them verbatim', () => {
    const item = only('999999999 bags of rice');

    expect(item.quantity).toBeLessThanOrEqual(100_000);
  });

  it('ignores a phone number in the message body', () => {
    const item = only('call me on 0244123456, i want rice');

    expect(item.productId).toBe('rice50');
    expect(item.quantity).toBe(1);
  });
});
