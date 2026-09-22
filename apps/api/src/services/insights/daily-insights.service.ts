import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { requestAssistantText } from '../intent/assistant-client.js';
import { collectDayFacts, hasSomethingToSay, isoDate, previousDay, type DayFacts } from './collect.js';
import {
  buildInsightPrompt,
  composeFallbackInsight,
  splitNarrative,
  verifyInsightNarrative,
  type Insight,
} from './compose.js';

/**
 * The morning summary.
 *
 * Written once per shop per day and stored, so it is a record of what the owner
 * was told rather than a view that re-computes and quietly disagrees with
 * itself a week later.
 *
 * The one rule worth restating: the model writes the sentences and the server
 * supplies every figure. A narrative containing a number that is not in the
 * facts is discarded rather than corrected — a summary is what an owner makes
 * buying decisions on, and a plainer true one beats a livelier wrong one.
 */

const SYSTEM_PROMPT = [
  'You write a one-paragraph morning summary for the owner of a small business in Ghana.',
  'You are given yesterday\'s figures. You may use those figures and no others.',
  'You never estimate, never extrapolate, and never calculate a number that is not in front of you.',
  'You write the way a person speaks, briefly, with no greeting and no sign-off.',
  'Reply as JSON: {"headline": "...", "body": "..."}',
].join('\n');

/** Small and strict: two strings, nothing else. */
const INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['headline', 'body'],
  additionalProperties: false,
} as const;

export interface GeneratedInsight extends Insight {
  facts: DayFacts;
  /** The model that wrote it, or null when the deterministic fallback did. */
  model: string | null;
}

/**
 * Writes the summary for one shop and one day, or returns null when there is
 * nothing worth saying.
 *
 * Idempotent by storage: the row is unique per shop per day, so a retried job
 * updates rather than duplicating, and the owner's phone does not buzz twice.
 */
export async function generateDailyInsight(
  businessId: string,
  day: Date = previousDay(),
): Promise<GeneratedInsight | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, insightsEnabled: true },
  });

  if (!business?.insightsEnabled) return null;

  const facts = await collectDayFacts(businessId, day);

  if (!hasSomethingToSay(facts)) {
    logger.debug({ businessId, date: facts.date }, 'Nothing happened yesterday — no summary');
    return null;
  }

  const written = await writeNarrative(business.name, facts);

  await prisma.dailyInsight.upsert({
    where: { businessId_forDate: { businessId, forDate: new Date(`${facts.date}T00:00:00.000Z`) } },
    create: {
      businessId,
      forDate: new Date(`${facts.date}T00:00:00.000Z`),
      headline: written.headline,
      body: written.body,
      facts: facts as unknown as Prisma.InputJsonValue,
      model: written.model,
    },
    update: {
      headline: written.headline,
      body: written.body,
      facts: facts as unknown as Prisma.InputJsonValue,
      model: written.model,
    },
  });

  return { ...written, facts };
}

/**
 * Asks the model, then checks its arithmetic against the facts.
 *
 * Three ways to end up with the fallback, and all three are normal rather than
 * exceptional: the provider is down, the reply will not parse, or it contains a
 * figure nobody supplied. The last is the interesting one — it is not an error
 * anywhere, the model simply wrote a plausible number, and the only thing that
 * catches it is this.
 */
async function writeNarrative(
  businessName: string,
  facts: DayFacts,
): Promise<Insight & { model: string | null }> {
  const fallback = composeFallbackInsight(facts);

  const result = await requestAssistantText({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildInsightPrompt(businessName, facts),
    schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
  });

  if (!result.ok) {
    logger.info({ reason: result.reason }, 'Daily summary fell back to the plain version');
    return { ...fallback, model: null };
  }

  const parsed = parseInsight(result.text);
  if (!parsed) {
    logger.warn({ sample: result.text.slice(0, 200) }, 'Daily summary reply did not parse');
    return { ...fallback, model: null };
  }

  const whole = `${parsed.headline}\n${parsed.body}`;

  if (!verifyInsightNarrative(whole, facts)) {
    // Logged at warn with the text, because a model inventing figures about a
    // shop's own takings is worth someone reading, not a silent downgrade.
    logger.warn(
      { businessName, date: facts.date, narrative: whole.slice(0, 400) },
      'Daily summary contained a figure that is not in the facts — using the plain version',
    );
    return { ...fallback, model: null };
  }

  return { ...parsed, model: result.model };
}

function parseInsight(raw: string): Insight | null {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) {
      // Not JSON at all. Some models answer a two-field schema in prose, and
      // the text is still usable — it just has to be split by hand.
      const split = splitNarrative(raw);
      return split.headline ? split : null;
    }

    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      headline?: unknown;
      body?: unknown;
    };

    if (typeof parsed.headline !== 'string' || parsed.headline.trim().length === 0) return null;

    return {
      headline: parsed.headline.trim(),
      body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
    };
  } catch {
    return null;
  }
}

export interface StoredInsight {
  id: string;
  forDate: Date;
  headline: string;
  body: string;
  facts: DayFacts;
  /** Null when the plain version was used rather than a generated one. */
  model: string | null;
  sentAt: Date | null;
}

export async function listInsights(businessId: string, limit = 14): Promise<StoredInsight[]> {
  const rows = await prisma.dailyInsight.findMany({
    where: { businessId },
    orderBy: { forDate: 'desc' },
    take: Math.min(limit, 90),
    select: {
      id: true,
      forDate: true,
      headline: true,
      body: true,
      facts: true,
      model: true,
      sentAt: true,
    },
  });

  return rows.map((row) => ({ ...row, facts: row.facts as unknown as DayFacts }));
}

/** The most recent summary, for the dashboard card. */
export async function latestInsight(businessId: string): Promise<StoredInsight | null> {
  const [first] = await listInsights(businessId, 1);
  return first ?? null;
}

/** Marks a summary as delivered to the owner, so a re-run does not send twice. */
export async function markInsightSent(businessId: string, forDate: Date): Promise<boolean> {
  const updated = await prisma.dailyInsight.updateMany({
    where: { businessId, forDate, sentAt: null },
    data: { sentAt: new Date() },
  });

  return updated.count === 1;
}

/** Shops that should get a summary this morning. */
export async function businessesWantingInsights(): Promise<
  Array<{ id: string; insightsToWhatsApp: boolean }>
> {
  return prisma.business.findMany({
    where: {
      insightsEnabled: true,
      active: true,
      suspendedAt: null,
      deletedAt: null,
    },
    select: { id: true, insightsToWhatsApp: true },
  });
}

export { isoDate, previousDay };
