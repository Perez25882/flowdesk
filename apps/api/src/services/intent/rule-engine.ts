import { type IntentClassification, IntentType } from '@flowdesk/shared';

interface PatternRule {
  patterns: (string | RegExp)[];
  weight: number;
}

interface IntentRules {
  intent: IntentType;
  rules: PatternRule[];
}

const AMBIGUITY_THRESHOLD = 0.1;
const AMBIGUITY_PENALTY = 0.15;
const MIN_CONFIDENCE_FOR_CLASSIFICATION = 0.25;

function normalizeText(input: string): string {
  let text = input.trim().toLowerCase();

  const abbreviations: Record<string, string> = {
    pls: 'please',
    plz: 'please',
    wnt: 'want',
    nd: 'need',
    'hw mch': 'how much',
    'hw much': 'how much',
    abt: 'about',
    u: 'you',
    ur: 'your',
    thx: 'thanks',
    tx: 'thanks',
    tnx: 'thanks',
  };

  for (const [abbr, expanded] of Object.entries(abbreviations)) {
    const regex = new RegExp(`\\b${abbr}\\b`, 'g');
    text = text.replace(regex, expanded);
  }

  text = text.replace(/\s+/g, ' ');
  return text;
}

function matchesPattern(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    // Use a negative lookaround so a pattern only matches when it is not
    // part of a larger ASCII word. This prevents substring overlaps like
    // "i want" also matching "i wan" while still allowing non-ASCII
    // prefixes/suffixes (e.g., Twi/Pidgin phrases) to match correctly.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
    return regex.test(text);
  }
  return pattern.test(text);
}

const INTENT_RULES: IntentRules[] = [
  {
    intent: IntentType.ORDER,
    rules: [
      {
        patterns: [
          'i want',
          'i need',
          'send me',
          'give me',
          'abeg give',
          'make i get',
          'please send',
          'can i get',
          'order for',
          'i wan',
          "i'll take",
          'let me have',
          'i go need',
          'i would like',
          'i dey want',
          'abeg send',
          'kindly send',
          'i am looking for',
        ],
        weight: 0.5,
      },
      {
        patterns: [
          'mepɛ',
          'mepe',
          'mesrɛ',
          'mesre',
          'kɔ me',
          'kɔ mee',
          'mepɛ sɛ',
          'mepe se',
        ],
        weight: 0.6,
      },
      {
        patterns: [
          /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(bags?|cartons?|boxes?|packs?|pieces?|bottles?|sachets?|dozens?|crates?)\b/,
          /\b(bags?|cartons?|boxes?|packs?|pieces?|bottles?|sachets?|dozens?|crates?)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/,
          /[x×]\d+/,
          /\d+[x×]\d+/,
        ],
        weight: 0.3,
      },
    ],
  },
  {
    intent: IntentType.PAYMENT,
    rules: [
      {
        patterns: [
          "i've paid",
          'i have paid',
          'payment done',
          'paid already',
          'check your momo',
          'money sent',
          'receipt',
          'i sent',
          'transferred',
          'bank alert',
          'i don pay',
          'payment made',
          'i have made payment',
          'i just paid',
          'i already paid',
          'payment sent',
          'i have transferred',
        ],
        weight: 0.55,
      },
      {
        patterns: [
          'screenshot',
          'proof',
          'mtn momo',
          'vodafone cash',
          'airteltigo',
          'confirm payment',
          'momo payment',
          'mobile money',
          'payment confirmation',
        ],
        weight: 0.3,
      },
    ],
  },
  {
    intent: IntentType.INQUIRY,
    rules: [
      {
        patterns: [
          'how much',
          'what is the price',
          'price of',
          'cost of',
          'do you have',
          'is it available',
          'any stock',
          'still available',
          'how many',
          'are you open',
          'what are your',
          'info on',
          'tell me about',
          'do you sell',
          'can i buy',
          'what is the cost',
          'how much is',
          'what do you charge',
          'do you stock',
          'is there',
        ],
        weight: 0.55,
      },
    ],
  },
  {
    intent: IntentType.STATUS_CHECK,
    rules: [
      {
        patterns: [
          'my order',
          'when will',
          'still waiting',
          'where is my',
          'what happened to',
          'order status',
          'has my order',
          'update me on',
          'when are you',
          'how far my',
          'any update',
          'i am waiting',
          'i dey wait',
        ],
        weight: 0.6,
      },
      {
        patterns: [/\bFD-\d{3,}\b/i],
        weight: 0.5,
      },
    ],
  },
  {
    intent: IntentType.COMPLAINT,
    rules: [
      {
        patterns: [
          'wrong item',
          "didn't receive",
          'did not receive',
          'incomplete',
          'bad quality',
          'refund',
          'not delivered',
          'missing',
          'damaged',
          'this is not what',
          'disappointed',
          'problem with',
          'spoiled',
          'expired',
          'broken',
          'defective',
          'poor quality',
          'not working',
          'i am not happy',
          'i dey vex',
          'this is wrong',
          'i want my money',
        ],
        weight: 0.6,
      },
    ],
  },
  {
    intent: IntentType.GREETING,
    rules: [
      {
        patterns: [
          /^hi\b/,
          /^hello\b/,
          /^hey\b/,
          /^good morning\b/,
          /^good afternoon\b/,
          /^good evening\b/,
          /^good day\b/,
          /^maakye\b/,
          /^maaha\b/,
          /^maadwo\b/,
          /^ɛte sɛn/,
          /^ete sen/,
          /^yɛ wo ara/,
          /^ye wo ara/,
        ],
        weight: 0.7,
      },
    ],
  },
];

interface IntentScore {
  intent: IntentType;
  score: number;
  matchedPatterns: string[];
}

/**
 * Score an intent using an additive-with-saturation model: every matched
 * pattern contributes its rule's weight, the total is capped at 1.0, and
 * an ambiguity penalty is applied when the top two intents are close.
 *
 * This makes confidence proportional to the number of independent signals
 * in the message, while keeping scores bounded and deterministic.
 */
function scoreIntent(text: string, rules: IntentRules): IntentScore {
  let score = 0;
  const matchedPatterns: string[] = [];

  for (const rule of rules.rules) {
    for (const pattern of rule.patterns) {
      if (matchesPattern(text, pattern)) {
        score += rule.weight;
        matchedPatterns.push(typeof pattern === 'string' ? pattern : pattern.source);
      }
    }
  }

  return {
    intent: rules.intent,
    score: Math.min(score, 1.0),
    matchedPatterns: [...new Set(matchedPatterns)],
  };
}

function applyAmbiguityPenalty(scores: IntentScore[]): IntentScore[] {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const second = sorted[1];

  if (!top || !second || top.score === 0 || second.score === 0) {
    return scores;
  }

  const gap = top.score - second.score;

  if (gap <= AMBIGUITY_THRESHOLD) {
    return scores.map((s) => {
      if (s.intent === top.intent || s.intent === second.intent) {
        return {
          ...s,
          score: Math.max(0, s.score - AMBIGUITY_PENALTY),
        };
      }
      return s;
    });
  }

  return scores;
}

/** Weight added when the message names a product this business actually sells. */
const CATALOG_MENTION_WEIGHT = 0.3;
/** Additional weight when that product is paired with a quantity. */
const CATALOG_QUANTITY_WEIGHT = 0.5;

const BARE_QUANTITY = /\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|dozen)\b/;

/**
 * Escapes a catalog term for use in a regular expression, so a product name
 * containing punctuation ("Milo 3-in-1") cannot corrupt the pattern.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scores how strongly the message points at the business's own catalog.
 *
 * Word boundaries matter: without them "water" would match "waterfall" and a
 * holiday anecdote would become an order.
 */
function scoreCatalogEvidence(normalized: string, catalogTerms: string[]): number {
  if (catalogTerms.length === 0) return 0;

  const mentioned = catalogTerms.some((term) => {
    const trimmed = term.trim();
    if (trimmed.length < 3) return false;
    return new RegExp(`\\b${escapeRegExp(trimmed.toLowerCase())}\\b`).test(normalized);
  });

  if (!mentioned) return 0;

  return BARE_QUANTITY.test(normalized)
    ? CATALOG_MENTION_WEIGHT + CATALOG_QUANTITY_WEIGHT
    : CATALOG_MENTION_WEIGHT;
}

/**
 * A competing intent scoring at least this much means the message already
 * states its purpose explicitly, and catalog evidence must not override it.
 */
const COMPETING_INTENT_THRESHOLD = 0.4;

/**
 * Classifies a message, optionally using the business's product names as
 * evidence.
 *
 * Catalog evidence resolves messages that state no intent at all ("5 malta") —
 * it is a tie-breaker, not an override. When any other intent has already
 * matched explicit patterns, the boost is withheld entirely, so "I just paid
 * 500 for the rice" stays a payment notice rather than becoming a new order for
 * 500 bags.
 */
export function classifyIntent(text: string, catalogTerms: string[] = []): IntentClassification {
  const normalized = normalizeText(text);

  const baseScores = INTENT_RULES.map((rules) => scoreIntent(normalized, rules));

  const strongestCompetingScore = baseScores
    .filter((score) => score.intent !== IntentType.ORDER)
    .reduce((max, score) => Math.max(max, score.score), 0);

  const catalogEvidence =
    strongestCompetingScore >= COMPETING_INTENT_THRESHOLD
      ? 0
      : scoreCatalogEvidence(normalized, catalogTerms);

  const scores = baseScores.map((score) => {
    if (score.intent !== IntentType.ORDER || catalogEvidence === 0) {
      return score;
    }

    return {
      ...score,
      score: Math.min(1, score.score + catalogEvidence),
      matchedPatterns: [...score.matchedPatterns, 'catalog:product-mention'],
    };
  });

  const penalizedScores = applyAmbiguityPenalty(scores);

  const best = penalizedScores.reduce((max, current) =>
    current.score > max.score ? current : max,
  );

  if (best.score === 0) {
    return {
      intent: IntentType.UNCLASSIFIED,
      confidence: 0,
      matchedPatterns: [],
    };
  }

  if (best.score < MIN_CONFIDENCE_FOR_CLASSIFICATION) {
    const allPatterns = penalizedScores
      .filter((s) => s.matchedPatterns.length > 0)
      .flatMap((s) => s.matchedPatterns);

    return {
      intent: IntentType.OTHER,
      confidence: parseFloat(best.score.toFixed(2)),
      matchedPatterns: [...new Set(allPatterns)],
    };
  }

  return {
    intent: best.intent,
    confidence: parseFloat(best.score.toFixed(2)),
    matchedPatterns: [...new Set(best.matchedPatterns)],
  };
}
