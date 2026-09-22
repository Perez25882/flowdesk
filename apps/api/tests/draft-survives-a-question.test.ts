import { describe, expect, it } from 'vitest';
import { shouldAbandonDraft } from '../src/services/assistant/index.js';
import type { AssistantDecision } from '../src/services/assistant/decision.js';

/**
 * A customer asking a question has not walked away.
 *
 * This is a regression test for the most expensive bug found in the product so
 * far. A real conversation, recorded end to end:
 *
 *   customer  Give me one baggy jeans
 *   shop      Which area should we deliver to?      <- draft order created
 *   customer  Do you deliver to Ashaiman?
 *   shop      Let me ask about that and come right back.
 *
 * At that last turn the draft was ABANDONED. The customer had answered the
 * shop's own question with a question — the most ordinary thing a person does
 * while buying — and the order was destroyed. Everything afterwards was a
 * customer trying to buy something the system had already forgotten, ending
 * with the assistant promising "just wait for the link to pop up here" for a
 * link that could never be raised.
 *
 * The rule that did it read `if (pending && !decision.order.isOrder)`. Its
 * comment describes a real problem — a stale draft swallowing an unrelated
 * message days later — but it could not tell "never mind" from "yes, but does
 * it reach my area?", and those are opposites.
 *
 * The asymmetry decides the design: a draft wrongly kept costs one confusing
 * reply, which expiry then cleans up. A draft wrongly abandoned costs the sale
 * and tells nobody. So this abandons only on turns that genuinely read as a
 * change of subject, and leaves the rest to `expiresAt`.
 */

function decision(overrides: Partial<AssistantDecision>): AssistantDecision {
  return {
    intent: 'INQUIRY',
    order: { isOrder: false, complete: false },
    ...overrides,
  } as unknown as AssistantDecision;
}

describe('shouldAbandonDraft', () => {
  it('keeps the draft when the customer asks about delivery', () => {
    // The exact turn that lost the sale.
    expect(shouldAbandonDraft(decision({ intent: 'INQUIRY' }))).toBe(false);
  });

  it('keeps the draft when the customer asks how to pay', () => {
    expect(shouldAbandonDraft(decision({ intent: 'PAYMENT' }))).toBe(false);
  });

  it('keeps the draft when the customer chases the order', () => {
    expect(shouldAbandonDraft(decision({ intent: 'STATUS_CHECK' }))).toBe(false);
  });

  it('keeps the draft when the model could not classify the turn', () => {
    // "Mtn" — a one-word answer to the shop's own question. Classified
    // UNCLASSIFIED, and under the old rule that threw the order away.
    expect(shouldAbandonDraft(decision({ intent: 'UNCLASSIFIED' }))).toBe(false);
  });

  it('keeps the draft when the turn is itself an order', () => {
    expect(
      shouldAbandonDraft(decision({ intent: 'ORDER', order: { isOrder: true, complete: false } })),
    ).toBe(false);
  });

  it('abandons when the customer opens a fresh conversation', () => {
    // A greeting after a draft is someone starting again, not continuing.
    expect(shouldAbandonDraft(decision({ intent: 'GREETING' }))).toBe(true);
  });

  it('abandons when the customer complains', () => {
    // The subject has changed and the order is no longer what this is about.
    expect(shouldAbandonDraft(decision({ intent: 'COMPLAINT' }))).toBe(true);
  });
});
