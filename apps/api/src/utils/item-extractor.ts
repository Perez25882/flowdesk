export interface ExtractedItem {
  description: string;
  quantity: number;
  productId: string | null;
  unitPrice: number;
  matched: boolean;
}

export interface CatalogProduct {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  price: number;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const previousRow: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    const currentRow: number[] = new Array(n + 1);
    currentRow[0] = i;
    const ai = a[i - 1];

    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j]! + 1,
        currentRow[j - 1]! + 1,
        previousRow[j - 1]! + cost,
      );
    }

    for (let j = 0; j <= n; j++) {
      previousRow[j] = currentRow[j]!;
    }
  }

  return previousRow[n]!;
}

function similarityScore(a: string, b: string): number {
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance / maxLen;
}

const NUMBER_WORDS: Record<string, number> = {
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
  half: 0.5,
};

function parseQuantity(fragment: string): { quantity: number; description: string } {
  let text = fragment;

  const prefixMatch = text.match(/^\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (prefixMatch) {
    const qty = parseFloat(prefixMatch[1]!);
    const desc = text.slice(prefixMatch[0].length).trim();
    return { quantity: Number.isNaN(qty) ? 1 : qty, description: desc };
  }

  const suffixedMatch = text.match(/(\d+(?:\.\d+)?)\s*(bags?|cartons?|boxes?|packs?|pieces?|bottles?|sachets?|dozens?|crates?|kg|litres?|liters?)\b/i);
  if (suffixedMatch) {
    const qty = parseFloat(suffixedMatch[1]!);
    return {
      quantity: Number.isNaN(qty) ? 1 : qty,
      description: text.trim(),
    };
  }

  const wordMatch = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\b/i);
  if (wordMatch) {
    const qty = NUMBER_WORDS[wordMatch[1]!.toLowerCase()] ?? 1;
    return { quantity: qty, description: text.trim() };
  }

  const digitMatch = text.match(/\b(\d+(?:\.\d+)?)\b/);
  if (digitMatch) {
    const qty = parseFloat(digitMatch[1]!);
    return { quantity: Number.isNaN(qty) ? 1 : qty, description: text.trim() };
  }

  return { quantity: 1, description: text.trim() };
}

function splitIntoFragments(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/,/g, '|')
    .replace(/\band\b/g, '|')
    .replace(/\bplus\b/g, '|')
    .replace(/\n/g, '|');

  return normalized
    .split('|')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

const SIMILARITY_THRESHOLD = 0.75;

function findBestProductMatch(fragment: string, catalog: CatalogProduct[]): { product: CatalogProduct | null; confidence: number } {
  let bestProduct: CatalogProduct | null = null;
  let bestScore = 0;

  const candidates = [fragment, fragment.replace(/\d/g, '').trim()];

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;

    for (const product of catalog) {
      const names = [product.name.toLowerCase(), ...product.aliases.map((a) => a.toLowerCase())];
      for (const name of names) {
        const score = similarityScore(candidate, name);
        if (score > bestScore) {
          bestScore = score;
          bestProduct = product;
        }
      }
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD) {
    return { product: bestProduct, confidence: bestScore };
  }

  return { product: null, confidence: bestScore };
}

export function extractItemsFromText(text: string, catalog: CatalogProduct[]): ExtractedItem[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const fragments = splitIntoFragments(text);
  const results: ExtractedItem[] = [];

  for (const fragment of fragments) {
    const { quantity, description } = parseQuantity(fragment);
    const match = findBestProductMatch(description, catalog);

    if (match.product) {
      results.push({
        description: match.product.name,
        quantity,
        productId: match.product.id,
        unitPrice: Number(match.product.price),
        matched: true,
      });
    } else {
      results.push({
        description: description,
        quantity,
        productId: null,
        unitPrice: 0,
        matched: false,
      });
    }
  }

  return results;
}
