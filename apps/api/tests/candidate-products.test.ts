import { describe, expect, it } from 'vitest';
import { findCandidateProducts, type CatalogProduct } from '../src/utils/item-extractor.js';

/**
 * Retrieval for the assistant's prompt.
 *
 * Distinct from `extractItemsFromText`, which is tuned for precision because a
 * wrong line item becomes a wrong order. Answering a question needs recall: if a
 * product the customer named is missing from the prompt, the assistant either
 * stays silent about it or invents an answer.
 */
const catalog: CatalogProduct[] = [
  { id: 'p_rice5', name: 'Rice 5kg', aliases: ['small rice'], unit: 'bag', price: 80 },
  { id: 'p_rice25', name: 'Rice 25kg', aliases: ['big rice'], unit: 'bag', price: 350 },
  { id: 'p_coke', name: 'Coca-Cola 33cl', aliases: ['coke', 'cola'], unit: 'bottle', price: 5 },
  { id: 'p_fanta', name: 'Fanta Orange 33cl', aliases: ['fanta'], unit: 'bottle', price: 5 },
  { id: 'p_malta', name: 'Malta Guinness 33cl', aliases: ['malta'], unit: 'bottle', price: 12.5 },
];

function ids(text: string, limit?: number): string[] {
  return findCandidateProducts(text, catalog, limit).map((c) => c.product.id);
}

describe('findCandidateProducts', () => {
  it('finds a product named directly', () => {
    expect(ids('how much is malta?')).toEqual(['p_malta']);
  });

  it('finds BOTH products in an "or" question', () => {
    // The motivating case. `splitIntoFragments` splits on and/plus/,/+ but not
    // "or", and `findBestMatch` returns on its first exact hit — so the
    // extractor surfaces only one of these two.
    const found = ids('do you have coke or fanta?');

    expect(found).toContain('p_coke');
    expect(found).toContain('p_fanta');
    expect(found).toHaveLength(2);
  });

  it('finds products separated by "and" too', () => {
    const found = ids('I want malta and coke');

    expect(found).toContain('p_malta');
    expect(found).toContain('p_coke');
  });

  it('ranks the alias-matched product first, keeping the sibling as context', () => {
    // "big rice" is an exact alias hit for the 25kg. The 5kg still surfaces
    // below it because "rice" is distinctive — which is what we want from
    // retrieval: the assistant sees the whole family and the ranking tells it
    // which one was actually named.
    const found = findCandidateProducts('price of big rice', catalog);

    expect(found[0]?.product.id).toBe('p_rice25');
    expect(found[0]?.confidence).toBe(1);
    expect(found.map((c) => c.product.id)).toContain('p_rice5');
    expect(found[1]!.confidence).toBeLessThan(1);
  });

  it('returns both variants when the mention is ambiguous', () => {
    // "rice" alone should surface both sizes so the assistant can ask which,
    // rather than silently assuming one.
    const found = ids('I want rice');

    expect(found).toContain('p_rice5');
    expect(found).toContain('p_rice25');
  });

  it('tolerates a typo', () => {
    expect(ids('how much for fantaa?')).toContain('p_fanta');
  });

  it('scores an exact match above a fuzzy one', () => {
    const [best] = findCandidateProducts('malta', catalog);

    expect(best?.product.id).toBe('p_malta');
    expect(best?.confidence).toBe(1);
  });

  it('reports which term matched, for debugging', () => {
    const [best] = findCandidateProducts('give me coke', catalog);

    expect(best?.matchedTerm).toBe('coke');
  });

  it('keeps one entry per product even when several aliases match', () => {
    const found = findCandidateProducts('coke cola coca-cola', catalog);

    expect(found.filter((c) => c.product.id === 'p_coke')).toHaveLength(1);
  });

  it('returns nothing when no product is mentioned', () => {
    expect(ids('are you open on sunday?')).toEqual([]);
  });

  it('respects the limit so the prompt stays bounded', () => {
    expect(ids('rice coke fanta malta', 2)).toHaveLength(2);
  });

  it('handles empty input and empty catalog without throwing', () => {
    expect(findCandidateProducts('', catalog)).toEqual([]);
    expect(findCandidateProducts('malta', [])).toEqual([]);
    expect(findCandidateProducts('malta', catalog, 0)).toEqual([]);
  });

  it('is deterministic when confidences tie', () => {
    // Ties break by product name, so the same message always yields the same
    // prompt — otherwise identical inputs could produce different answers.
    const first = ids('coke or fanta');
    const second = ids('coke or fanta');

    expect(first).toEqual(second);
  });
});
