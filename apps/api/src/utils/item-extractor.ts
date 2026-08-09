/**
 * Extracts priced line items from a free-text WhatsApp message.
 *
 * This is the core of the product: a customer types a normal sentence and an
 * order with real prices has to come out the other side.
 *
 * The algorithm is deliberately product-first:
 *
 *   1. Normalize and split the message into fragments (one per line item).
 *   2. Find the *longest* catalog term matching each fragment, so a specific
 *      product ("Rice 25kg") beats a generic alias ("rice").
 *   3. Remove the matched span from the fragment, THEN read the quantity from
 *      what remains.
 *
 * Step 3 is what makes "Rice 50kg" parse as one bag rather than fifty: the
 * digits belonging to the product name are consumed by the match before the
 * quantity parser ever sees them.
 */

export interface ExtractedItem {
  description: string;
  quantity: number;
  productId: string | null;
  unitPrice: number;
  matched: boolean;
  /** 1.0 for an exact term match, lower for a fuzzy one. 0 when unmatched. */
  confidence: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  price: number;
}

/** Below this, a fuzzy candidate is treated as no match at all. */
const SIMILARITY_THRESHOLD = 0.75;
/** Fuzzy matching on very short terms produces noise, so require some length. */
const MIN_FUZZY_TERM_LENGTH = 3;
/** Digit runs at least this long are identifiers (phone numbers), not quantities. */
const MIN_IDENTIFIER_DIGITS = 7;
/** Defensive ceiling so a typo cannot create a multi-million-unit order. */
const MAX_QUANTITY = 100_000;

const NUMBER_WORDS: Record<string, number> = {
  half: 0.5,
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
  dozen: 12,
  twenty: 20,
  thirty: 30,
  fifty: 50,
  hundred: 100,
};

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  let previousRow: number[] = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= m; i += 1) {
    const currentRow: number[] = new Array<number>(n + 1);
    currentRow[0] = i;
    const ai = a[i - 1];

    for (let j = 1; j <= n; j += 1) {
      const cost = ai === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j]! + 1,
        currentRow[j - 1]! + 1,
        previousRow[j - 1]! + cost,
      );
    }

    previousRow = currentRow;
  }

  return previousRow[n]!;
}

function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Lowercases, separates digit/letter runs ("50kg" -> "50 kg", "x3" -> "x 3")
 * and reduces every other character to a space. Splitting digits from letters
 * is what lets a product name containing a measurement tokenize the same way
 * whether the customer wrote "50kg" or "50 kg".
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Splits a message into one fragment per prospective line item. */
function splitIntoFragments(text: string): string[] {
  return text
    .split(/\r?\n|[,;]|\+|\band\b|\bplus\b/i)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

interface CatalogTerm {
  product: CatalogProduct;
  tokens: string[];
  /** Joined token form, used for fuzzy comparison. */
  text: string;
}

/**
 * Flattens the catalog into searchable terms (name + aliases), longest first so
 * the most specific term is always considered before a shorter generic one.
 */
function buildTerms(catalog: CatalogProduct[]): CatalogTerm[] {
  const terms: CatalogTerm[] = [];

  for (const product of catalog) {
    for (const label of [product.name, ...product.aliases]) {
      const tokens = tokenize(label);
      if (tokens.length === 0) continue;
      terms.push({ product, tokens, text: tokens.join(' ') });
    }
  }

  return terms.sort((a, b) => b.tokens.length - a.tokens.length || b.text.length - a.text.length);
}

interface TermMatch {
  product: CatalogProduct;
  start: number;
  length: number;
  confidence: number;
}

function findContiguousRun(haystack: string[], needle: string[]): number {
  const limit = haystack.length - needle.length;

  for (let start = 0; start <= limit; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }

  return -1;
}

/**
 * Finds the best catalog term within a fragment. Exact contiguous matches are
 * preferred; failing that, each same-width window of the fragment is compared
 * to the term and the best-scoring one above the threshold wins.
 */
function findBestMatch(tokens: string[], terms: CatalogTerm[]): TermMatch | null {
  let best: TermMatch | null = null;

  for (const term of terms) {
    if (term.tokens.length > tokens.length) continue;

    const exactStart = findContiguousRun(tokens, term.tokens);
    if (exactStart !== -1) {
      // Terms are length-sorted, so the first exact hit is the most specific
      // one available — nothing considered later can beat it.
      return {
        product: term.product,
        start: exactStart,
        length: term.tokens.length,
        confidence: 1,
      };
    }

    if (term.text.length < MIN_FUZZY_TERM_LENGTH) continue;

    for (let start = 0; start + term.tokens.length <= tokens.length; start += 1) {
      const window = tokens.slice(start, start + term.tokens.length).join(' ');
      const score = similarityScore(term.text, window);

      if (score >= SIMILARITY_THRESHOLD && (best === null || score > best.confidence)) {
        best = { product: term.product, start, length: term.tokens.length, confidence: score };
      }
    }
  }

  return best;
}

function isIdentifierLike(token: string): boolean {
  return /^\d+$/.test(token) && token.length >= MIN_IDENTIFIER_DIGITS;
}

function clampQuantity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(value, MAX_QUANTITY);
}

/**
 * Reads a quantity from the tokens left over after the product span has been
 * removed. Recognises "x3"/"3x" multipliers, spelled-out numbers and plain
 * digits, ignoring long digit runs that are clearly identifiers.
 *
 * Returns null when the fragment states no quantity, letting the caller
 * distinguish "one bag" from "no quantity mentioned".
 */
function findQuantity(tokens: string[]): number | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];

    if (token === 'x' && next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
      return clampQuantity(Number.parseFloat(next));
    }

    if (next === 'x' && /^\d+(\.\d+)?$/.test(token) && !isIdentifierLike(token)) {
      return clampQuantity(Number.parseFloat(token));
    }
  }

  for (const token of tokens) {
    const word = NUMBER_WORDS[token];
    if (word !== undefined) {
      return clampQuantity(word);
    }

    if (/^\d+(\.\d+)?$/.test(token) && !isIdentifierLike(token)) {
      return clampQuantity(Number.parseFloat(token));
    }
  }

  return null;
}

interface FragmentResult {
  item: ExtractedItem;
  /** True when the customer wrote an explicit quantity, used to filter filler. */
  hasExplicitQuantity: boolean;
}

function analyseFragment(fragment: string, terms: CatalogTerm[]): FragmentResult | null {
  const tokens = tokenize(fragment);
  if (tokens.length === 0) return null;

  const match = findBestMatch(tokens, terms);
  const remainder = match
    ? [...tokens.slice(0, match.start), ...tokens.slice(match.start + match.length)]
    : tokens;

  const stated = findQuantity(remainder);
  const quantity = stated ?? 1;

  const item: ExtractedItem = match
    ? {
        description: match.product.name,
        quantity,
        productId: match.product.id,
        unitPrice: match.product.price,
        matched: true,
        confidence: match.confidence,
      }
    : {
        description: fragment.trim(),
        quantity,
        productId: null,
        unitPrice: 0,
        matched: false,
        confidence: 0,
      };

  return { item, hasExplicitQuantity: stated !== null };
}

export function extractItemsFromText(text: string, catalog: CatalogProduct[]): ExtractedItem[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const terms = buildTerms(catalog);
  const results = splitIntoFragments(text)
    .map((fragment) => analyseFragment(fragment, terms))
    .filter((result): result is FragmentResult => result !== null);

  if (results.length === 0) {
    return [];
  }

  const anyMatched = results.some((result) => result.item.matched);

  // Once something matched, leftover fragments with neither a product nor an
  // explicit quantity are conversational filler ("call me on 024...") rather
  // than line items. When nothing matched at all we keep everything, so the
  // order is still created with the customer's own words for manual resolution.
  const kept = anyMatched
    ? results.filter((result) => result.item.matched || result.hasExplicitQuantity)
    : results;

  return kept.map((result) => result.item);
}
