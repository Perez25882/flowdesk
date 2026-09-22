import { describe, expect, it } from 'vitest';
import { carriesPersonalDetail } from '../src/services/assistant/context-builder.js';
import { assertsCheckableFact } from '../src/services/assistant/grounding.js';

/**
 * Regression locks for three findings in the assistant-voice work.
 *
 * All three came from the same pressure: changes made to help the assistant
 * sound human each stepped around a safety control rather than through it.
 *
 * The tests run in both directions on purpose. A fix that blocks the attack but
 * also blocks ordinary shop talk has replaced a security bug with a product
 * one — and nobody files a bug report about an assistant that has quietly
 * stopped replying.
 */

describe('owner voice examples never carry one customer into another chat', () => {
  /**
   * The leak: voice examples are the owner's own messages to OTHER customers,
   * pasted whole into the prompt under an instruction to imitate them. A model
   * told to copy the register of a line copies its contents along with it.
   */
  it('rejects a line naming a customer, a balance and a place', () => {
    expect(
      carriesPersonalDetail(
        "Kwame, your 12 bags are set aside, balance GHS 400, I'll bring them Friday.",
      ),
    ).toBe(true);
  });

  it('rejects a bare name even with nothing else in the line', () => {
    expect(carriesPersonalDetail('Thank you Ama, see you tomorrow.')).toBe(true);
  });

  it('rejects any figure, since order refs and balances are figures', () => {
    expect(carriesPersonalDetail('Your order of 3 crates is ready for pickup.')).toBe(true);
  });

  it('rejects a place name mid-sentence', () => {
    expect(carriesPersonalDetail('We can drop it at East Legon before evening.')).toBe(true);
  });

  it('rejects money written in words rather than figures', () => {
    expect(carriesPersonalDetail('Balance is forty cedis, pay when you collect.')).toBe(true);
  });

  // The other direction. These are the lines the feature exists to learn from:
  // they carry the shop's register and nothing that belongs to anybody.
  it('allows an ordinary courtesy with nobody in it', () => {
    expect(carriesPersonalDetail("You're welcome, we dey open till evening.")).toBe(false);
  });

  it('allows Pidgin, which is the point of learning the voice at all', () => {
    expect(carriesPersonalDetail('No wahala, make you come tomorrow morning.')).toBe(false);
  });

  it('allows a sentence-initial capital, which signals nothing', () => {
    expect(carriesPersonalDetail('Please send me the details and we go arrange am.')).toBe(false);
  });
});

describe('a pleasantry that skips the grounding checks must assert nothing', () => {
  /**
   * The bypass exists for a good reason: the validator was flagging plain
   * greetings as ungrounded claims and holding them for manual review, which is
   * absurd for the safest message we send. These tests keep that working while
   * closing what it opened.
   */
  it('treats a spelled-out digit run as a number', () => {
    expect(
      assertsCheckableFact(
        'Good morning! Our MoMo line changed, send to zero two four four, one two three.',
      ),
    ).toBe(true);
  });

  it('treats a payment redirection as a claim even with no digits at all', () => {
    expect(assertsCheckableFact('Please pay into our new account from now on.')).toBe(true);
  });

  it('treats a link as unverifiable', () => {
    expect(assertsCheckableFact('Kindly confirm your order at www.example-shop.test')).toBe(true);
  });

  // The other direction, and the reason the bypass was written at all. If these
  // start failing, every greeting goes to manual review and the assistant turns
  // into a queue of chores for an owner already too busy to read her messages.
  it('still lets a plain greeting through', () => {
    expect(assertsCheckableFact("Good morning, welcome to Ama's Provisions!")).toBe(false);
  });

  it('still lets thanks through', () => {
    expect(assertsCheckableFact('Thank you for shopping with us, we appreciate you.')).toBe(false);
  });

  it('does not mistake ordinary counting words for a phone number', () => {
    expect(assertsCheckableFact('One moment please, let me check for you.')).toBe(false);
  });
});
