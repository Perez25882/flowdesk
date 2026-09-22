import { describe, expect, it } from 'vitest';
import { renderRepliedTo, type RepliedToContext } from '../src/services/assistant/status-context.js';

/**
 * A shop posts a flyer to their Status and twenty people reply "how much?".
 *
 * Four different things can be true about what they are pointing at, and each
 * one calls for a different question back. The failure this replaces produced
 * the same useless question in all four: "which item do you mean?", asked of
 * someone looking straight at it.
 */

function context(overrides: Partial<RepliedToContext> = {}): RepliedToContext {
  return { body: null, fromShop: true, isImage: false, unresolved: false, ...overrides };
}

describe('renderRepliedTo', () => {
  it('quotes a described picture and forbids asking which item', () => {
    const rendered = renderRepliedTo(
      context({ body: 'Three kaftans, navy, white and striped. GHS 250 printed on it.', isImage: true }),
    );

    expect(rendered).toContain('Three kaftans');
    expect(rendered).toContain('GHS 250');
    expect(rendered.toLowerCase()).toContain('do not ask them which item');
  });

  it('says plainly whose picture it was', () => {
    const fromShop = renderRepliedTo(context({ body: 'A red bag', isImage: true, fromShop: true }));
    const fromCustomer = renderRepliedTo(
      context({ body: 'A red bag', isImage: true, fromShop: false }),
    );

    expect(fromShop).toContain('this shop posted');
    expect(fromCustomer).toContain('they sent');
  });

  it('admits when the picture is held but not understood, and still forbids the blank question', () => {
    const rendered = renderRepliedTo(context({ isImage: true, body: null }));

    // Asserted on the joined text rather than a phrase that happens to span a
    // line break in the prompt — the wrapping is presentation, the meaning is not.
    expect(rendered.replace(/\n/g, ' ')).toContain('not a description of it');
    expect(rendered.toLowerCase()).toContain('do not ask them what they mean');
    // The useful instruction: name candidates rather than going blank.
    expect(rendered.toLowerCase()).toContain('catalogue');
  });

  it('handles the commonest case of all — a Status we never received', () => {
    // This is not a rare edge. Meta does not deliver Status posts, so unless
    // the owner's own app mirrored it, the referenced message is simply absent.
    const rendered = renderRepliedTo(context({ unresolved: true }));

    expect(rendered).toContain('Status');
    expect(rendered).toContain('cannot see it');
    expect(rendered.toLowerCase()).toContain('do not ask them what they are referring to');
    // And it gives an example of the right question, not just a prohibition.
    expect(rendered).toContain('blue kaftan');
  });

  it('never tells the model to ask the customer to repeat themselves', () => {
    // The whole point. Every branch must leave the assistant with something
    // better to say than "what do you mean?".
    const branches = [
      context({ unresolved: true }),
      context({ isImage: true }),
      context({ isImage: true, body: 'A red bag' }),
      context({ body: 'We have new stock in' }),
    ];

    for (const branch of branches) {
      const rendered = renderRepliedTo(branch).toLowerCase();
      expect(rendered).not.toMatch(/ask them to (repeat|say again)/);
    }
  });

  it('falls back to something harmless when there is genuinely nothing', () => {
    const rendered = renderRepliedTo(context({ body: null, isImage: false }));
    expect(rendered).toContain('nothing in it to go on');
  });
});
