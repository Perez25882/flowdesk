import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_KEYS,
  getCustomerFirstName,
  getTemplateKeyForOrderStatus,
  isTemplateEnabled,
  parseTemplateConfig,
  renderTemplate,
  shouldSendAutoReply,
} from '../src/services/templates/template-engine.js';

describe('parseTemplateConfig', () => {
  it('treats an absent configuration as "all defaults, nothing disabled"', () => {
    for (const value of [null, undefined, 'nonsense', 42]) {
      const config = parseTemplateConfig(value);
      expect(config.overrides).toEqual({});
      expect(config.disabled).toEqual([]);
    }
  });

  it('reads the structured shape', () => {
    const config = parseTemplateConfig({
      overrides: { order_pending: 'Custom pending text' },
      disabled: ['greeting'],
    });

    expect(config.overrides.order_pending).toBe('Custom pending text');
    expect(config.disabled).toEqual(['greeting']);
  });

  it('still reads the older flat shape so existing rows keep working', () => {
    const config = parseTemplateConfig({ order_confirmed: 'Flat style override' });

    expect(config.overrides.order_confirmed).toBe('Flat style override');
  });

  it('ignores unknown keys instead of rejecting the whole configuration', () => {
    // A stale key left by an older release must not disable auto-replies
    // for every other template.
    const config = parseTemplateConfig({
      overrides: { order_pending: 'Kept', orderReceived: 'Dropped', nonsense: 'Dropped' },
      disabled: ['greeting', 'not_a_real_template'],
    });

    expect(config.overrides.order_pending).toBe('Kept');
    expect(Object.keys(config.overrides)).toEqual(['order_pending']);
    expect(config.disabled).toEqual(['greeting']);
  });

  it('ignores blank overrides so an empty field falls back to the default', () => {
    const config = parseTemplateConfig({ overrides: { order_pending: '   ' } });

    expect(config.overrides.order_pending).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  const empty = parseTemplateConfig(null);

  it('fills every variable in the default template', () => {
    const text = renderTemplate(empty, 'order_pending', {
      name: 'Emmanuel',
      ref: 'FD-00042',
      business: "Ama's Store",
    });

    expect(text).toContain('Emmanuel');
    expect(text).toContain('FD-00042');
    expect(text).toContain("Ama's Store");
    expect(text).not.toContain('{');
  });

  it('uses the owner override in place of the default', () => {
    const config = parseTemplateConfig({
      overrides: { order_pending: 'Yo {name}, order {ref} received. — {business}' },
    });

    const text = renderTemplate(config, 'order_pending', {
      name: 'Kofi',
      ref: 'FD-00001',
      business: 'Shop',
    });

    expect(text).toBe('Yo Kofi, order FD-00001 received. — Shop');
  });

  it('falls back to "there" when the customer name is unknown', () => {
    const text = renderTemplate(empty, 'greeting', { business: 'Shop' });

    expect(text).toContain('there');
    expect(text).not.toContain('{name}');
  });

  it('leaves no unreplaced placeholders in any default template', () => {
    // A stray {variable} would be sent verbatim to a real customer.
    for (const key of TEMPLATE_KEYS) {
      const text = renderTemplate(empty, key, {
        name: 'Test',
        ref: 'FD-00001',
        business: 'Shop',
        amount: '10.00',
        status: 'Pending',
        details: 'Details',
        reason: 'Reason',
      });

      expect(text, `template: ${key}`).not.toMatch(/\{[a-z_]+\}/);
    }
  });
});

describe('isTemplateEnabled', () => {
  it('is enabled unless the owner switched it off', () => {
    const config = parseTemplateConfig({ disabled: ['greeting'] });

    expect(isTemplateEnabled(config, 'greeting')).toBe(false);
    expect(isTemplateEnabled(config, 'order_pending')).toBe(true);
  });
});

/**
 * The window is measured from the last message received FROM the customer.
 *
 * Passing `lastInteractionAt` here was a real defect: the owner replying from
 * the WhatsApp Business app bumps that field, so Flowdesk believed the window
 * was open after Meta had closed it, and the send died in the dead-letter queue
 * with nothing shown to the owner.
 */
describe('shouldSendAutoReply', () => {
  it('allows a reply inside the 24-hour service window', () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    expect(shouldSendAutoReply(anHourAgo).withinWindow).toBe(true);
  });

  it('blocks a free-form reply once the window has closed', () => {
    // Meta rejects free-form messages outside 24h; sending anyway would fail
    // and could count against the number's quality rating.
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    expect(shouldSendAutoReply(twoDaysAgo).withinWindow).toBe(false);
  });

  it('blocks a reply when the customer has never messaged in', () => {
    // No inbound message means the window has never opened. This used to
    // return true, which is the wrong way to fail on a rule Meta enforces:
    // a customer the owner messaged first would be replied to automatically
    // and every send would be rejected.
    expect(shouldSendAutoReply(null).withinWindow).toBe(false);
    expect(shouldSendAutoReply(undefined).withinWindow).toBe(false);
  });

  it('treats the boundary as closed rather than open', () => {
    const exactlyTwentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    expect(shouldSendAutoReply(exactlyTwentyFourHoursAgo).withinWindow).toBe(false);
  });
});

describe('getTemplateKeyForOrderStatus', () => {
  it('maps every order status to its notification template', () => {
    expect(getTemplateKeyForOrderStatus('PENDING')).toBe('order_pending');
    expect(getTemplateKeyForOrderStatus('CONFIRMED')).toBe('order_confirmed');
    expect(getTemplateKeyForOrderStatus('PROCESSING')).toBe('order_processing');
    expect(getTemplateKeyForOrderStatus('FULFILLED')).toBe('order_fulfilled');
    expect(getTemplateKeyForOrderStatus('CANCELLED')).toBe('order_cancelled');
  });
});

describe('getCustomerFirstName', () => {
  it('takes the first word of the profile name', () => {
    expect(getCustomerFirstName('Emmanuel Osei Mensah')).toBe('Emmanuel');
  });

  it('returns empty for a missing name so the caller can substitute', () => {
    expect(getCustomerFirstName(null)).toBe('');
    expect(getCustomerFirstName(undefined)).toBe('');
  });
});
