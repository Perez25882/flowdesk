import { formatAmount } from '../templates/template-engine.js';
import type { DayFacts } from './collect.js';

/**
 * Turning yesterday's numbers into something worth reading at 6am.
 *
 * The model writes the sentences; it does not supply the figures. Every number
 * that appears in the output is checked against the facts before the summary is
 * stored or sent, and a narrative that fails the check is thrown away in favour
 * of the deterministic one below.
 *
 * That asymmetry is deliberate. A wrong price reaches one customer. A wrong
 * revenue figure in a morning summary is what an owner decides next week's
 * buying on, and they will believe it, because it came from their own system
 * about their own shop.
 */

/** Numbers every summary may contain regardless: they mean nothing on their own. */
const ALWAYS_ALLOWED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 24, 30, 100]);

export interface Insight {
  headline: string;
  body: string;
}

/**
 * Every figure the narrative may state, in minor units where it is money.
 *
 * Derived rather than hand-listed so a new fact cannot be added to `DayFacts`
 * and then silently fail verification because nobody updated a second list.
 */
export function allowedFigures(facts: DayFacts): Set<number> {
  const allowed = new Set<number>(ALWAYS_ALLOWED);

  const add = (value: number): void => {
    if (!Number.isFinite(value)) return;
    allowed.add(Math.round(value * 100) / 100);
    allowed.add(Math.round(value));
  };

  add(facts.messagesIn);
  add(facts.messagesOut);
  add(facts.customersWhoWrote);
  add(facts.newCustomers);
  add(facts.ordersCreated);
  add(facts.ordersValue);
  add(facts.ordersFulfilled);
  add(facts.ordersCancelled);
  add(facts.revenue);
  add(facts.paymentLinksOpen);
  add(facts.paymentLinksOpenValue);
  add(facts.awaitingOwner);
  add(facts.unverifiedRepliesSent);
  add(facts.lowStockCount);
  add(facts.previous.messagesIn);
  add(facts.previous.ordersCreated);
  add(facts.previous.revenue);

  for (const product of facts.topProducts) {
    add(product.quantity);
    add(product.value);
  }

  // Differences and multiples are legitimate things to say — "GHS 200 more than
  // Monday", "twice as many messages" — and appear in no raw field, so they are
  // derived here rather than being rejected as invented.
  add(facts.revenue - facts.previous.revenue);
  add(facts.previous.revenue - facts.revenue);
  add(facts.messagesIn - facts.previous.messagesIn);
  add(facts.previous.messagesIn - facts.messagesIn);
  add(facts.ordersCreated - facts.previous.ordersCreated);
  add(facts.previous.ordersCreated - facts.ordersCreated);
  add(facts.ordersValue - facts.revenue);

  if (facts.previous.revenue > 0) {
    add(Math.round((facts.revenue / facts.previous.revenue) * 100));
    add(Math.round(((facts.revenue - facts.previous.revenue) / facts.previous.revenue) * 100));
  }
  if (facts.previous.messagesIn > 0) {
    add(Math.round((facts.messagesIn / facts.previous.messagesIn) * 100));
    add(
      Math.round(((facts.messagesIn - facts.previous.messagesIn) / facts.previous.messagesIn) * 100),
    );
  }

  return allowed;
}

/** Numbers written in the text, normalised the way `allowedFigures` stores them. */
export function figuresIn(text: string): number[] {
  const found: number[] = [];

  // Commas inside a figure are thousands separators; a decimal point is not.
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) found.push(Math.round(value * 100) / 100);
  }

  return found;
}

/**
 * Whether every figure in the narrative came from the facts.
 *
 * Three things are removed before the check, because each is a number that is
 * not a claim about the business:
 *
 * Product names. "Coca-Cola 33cl", "Rice 5kg", "Tecno Spark 20" — a shop's
 * catalogue is full of digits, and without this a summary naming its own best
 * seller would be rejected as invented and fall back to the plain version
 * every single day. Found by the test that first wrote it.
 *
 * Dates and times. "16 Sep 2026" is three numbers and none of them is a figure
 * anyone acts on.
 */
export function verifyInsightNarrative(text: string, facts: DayFacts): boolean {
  let scrubbed = text;

  // Longest first, so "Rice 5kg" is removed before a shorter "Rice" could
  // leave "5kg" stranded in the text as a bare number.
  const names = [...facts.topProducts.map((p) => p.name), ...facts.lowStockNames]
    .filter((name) => name.trim().length > 0)
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    scrubbed = scrubbed.split(name).join(' ');
  }

  scrubbed = scrubbed
    .replace(/\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

  const allowed = allowedFigures(facts);
  return figuresIn(scrubbed).every((value) => allowed.has(value));
}

/**
 * What the model is asked for.
 *
 * The facts are given as a list rather than as JSON because the output is read
 * by a shopkeeper on a phone, and a model shown JSON writes like a report.
 */
export function buildInsightPrompt(businessName: string, facts: DayFacts): string {
  const lines: string[] = [
    `Shop: ${businessName}`,
    `Day: ${facts.date}`,
    '',
    `Messages from customers: ${facts.messagesIn} (day before: ${facts.previous.messagesIn})`,
    `Replies sent: ${facts.messagesOut}`,
    `Customers who wrote: ${facts.customersWhoWrote}, of whom new: ${facts.newCustomers}`,
    `Orders taken: ${facts.ordersCreated} worth ${formatAmount(facts.ordersValue)} (day before: ${facts.previous.ordersCreated})`,
    `Orders completed: ${facts.ordersFulfilled}. Cancelled: ${facts.ordersCancelled}`,
    `Money received: ${formatAmount(facts.revenue)} (day before: ${formatAmount(facts.previous.revenue)})`,
    `Payment links sent and still unpaid: ${facts.paymentLinksOpen} worth ${formatAmount(facts.paymentLinksOpenValue)}`,
    `Messages waiting for the owner right now: ${facts.awaitingOwner}`,
  ];

  if (facts.topProducts.length > 0) {
    lines.push(
      `Best sellers: ${facts.topProducts
        .map((p) => `${p.name} (${p.quantity}, ${formatAmount(p.value)})`)
        .join('; ')}`,
    );
  }

  if (facts.lowStockCount > 0) {
    lines.push(
      `Running low: ${facts.lowStockCount} product(s) — ${facts.lowStockNames.slice(0, 5).join(', ')}`,
    );
  }

  if (facts.unverifiedRepliesSent > 0) {
    lines.push(
      `Replies the assistant sent that it could not check against your records: ${facts.unverifiedRepliesSent}`,
    );
  }

  lines.push(
    '',
    'Write the shop owner a short morning summary of the day above.',
    '',
    'Rules:',
    '- First line: one sentence, the single thing that matters most. No greeting.',
    '- Then two to four short lines of detail. Not a list of every number — pick what is worth saying.',
    '- End with one thing worth doing today, only if the numbers point at one. If they do not, leave it out.',
    '- Use ONLY the figures above. Do not calculate percentages or totals that are not there, and do not estimate anything.',
    '- Write the way a person talks. "Quiet day, 3 orders" not "Order volume was 3".',
    '- Amounts as GHS with the figure, e.g. GHS 480.00.',
    '- No emoji. No markdown headings. Under 90 words.',
  );

  return lines.join('\n');
}

/**
 * The summary written without a model.
 *
 * Used when the model is unavailable, when it is too slow, and when what it
 * wrote contained a figure that is not in the facts. It is plainer than a
 * generated one and it is never wrong, which is the right trade for something
 * an owner makes decisions on.
 */
export function composeFallbackInsight(facts: DayFacts): Insight {
  const headline = describeHeadline(facts);
  const lines: string[] = [];

  lines.push(
    `${facts.messagesIn} message${facts.messagesIn === 1 ? '' : 's'} from ${facts.customersWhoWrote} customer${facts.customersWhoWrote === 1 ? '' : 's'}.`,
  );

  if (facts.ordersCreated > 0) {
    lines.push(
      `${facts.ordersCreated} order${facts.ordersCreated === 1 ? '' : 's'} worth ${formatAmount(facts.ordersValue)}.`,
    );
  }

  lines.push(`Money in: ${formatAmount(facts.revenue)}.`);

  if (facts.topProducts.length > 0) {
    const best = facts.topProducts[0]!;
    lines.push(`Best seller: ${best.name} (${best.quantity}).`);
  }

  if (facts.paymentLinksOpen > 0) {
    lines.push(
      `${facts.paymentLinksOpen} payment link${facts.paymentLinksOpen === 1 ? '' : 's'} still unpaid, ${formatAmount(facts.paymentLinksOpenValue)}.`,
    );
  }

  if (facts.awaitingOwner > 0) {
    lines.push(
      `${facts.awaitingOwner} message${facts.awaitingOwner === 1 ? '' : 's'} waiting for you.`,
    );
  }

  if (facts.lowStockCount > 0) {
    lines.push(`Running low: ${facts.lowStockNames.slice(0, 3).join(', ')}.`);
  }

  return { headline, body: lines.join('\n') };
}

function describeHeadline(facts: DayFacts): string {
  if (facts.revenue > facts.previous.revenue && facts.previous.revenue > 0) {
    return `${formatAmount(facts.revenue)} came in yesterday, up on the day before.`;
  }
  if (facts.revenue > 0) {
    return `${formatAmount(facts.revenue)} came in yesterday.`;
  }
  if (facts.ordersCreated > 0) {
    return `${facts.ordersCreated} order${facts.ordersCreated === 1 ? '' : 's'} yesterday, nothing paid yet.`;
  }
  if (facts.awaitingOwner > 0) {
    return `${facts.awaitingOwner} message${facts.awaitingOwner === 1 ? '' : 's'} still waiting for you.`;
  }
  return `A quiet day: ${facts.messagesIn} message${facts.messagesIn === 1 ? '' : 's'}, nothing sold.`;
}

/** Splits a model's reply into the headline and the rest. */
export function splitNarrative(text: string): Insight {
  const trimmed = text.trim();
  const breakAt = trimmed.indexOf('\n');

  if (breakAt === -1) return { headline: trimmed, body: '' };

  return {
    headline: trimmed.slice(0, breakAt).trim(),
    body: trimmed.slice(breakAt + 1).trim(),
  };
}
