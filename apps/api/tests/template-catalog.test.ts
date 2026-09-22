import { describe, expect, it } from 'vitest';
import { CUSTOMER_TEMPLATES } from '../src/services/notifications/customer-notifications.js';
import { OWNER_TEMPLATES } from '../src/services/notifications/owner-notifications.js';
import type { TemplateKey } from '../src/services/templates/template-engine.js';

/**
 * The templates Meta must have approved before a message can leave the 24-hour
 * window.
 *
 * These are not style assertions. Every gap they catch is the same production
 * failure: the window shuts, the code asks Meta for a template by name, Meta
 * has no such template, the send is rejected with error 132001, and the
 * customer is never told their order moved. The shop owner sees nothing — the
 * only record is a log line they cannot read.
 *
 * `order_dispatched` shipped exactly that way. `template-engine` mapped the
 * DISPATCHED status to it and `CUSTOMER_TEMPLATES` had no entry, so every
 * dispatch notification outside the window would have failed silently.
 */

/**
 * The statuses a customer is notified about, and therefore the keys that need a
 * Meta template. The conversational keys — greeting, inquiry, fallback and the
 * rest — are free-form replies sent INSIDE the window, so Meta requires no
 * template for them and they are deliberately absent here.
 */
const NOTIFICATION_KEYS: TemplateKey[] = [
  'order_pending',
  'order_confirmed',
  'order_processing',
  'order_dispatched',
  'order_fulfilled',
  'order_cancelled',
  'payment_received',
];

/** How many distinct `{{n}}` placeholders a body contains. */
function placeholderCount(body: string): number {
  return new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
}

/** The placeholder numbers in a body, deduplicated and ascending. */
function placeholderNumbers(body: string): number[] {
  const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  return [...new Set(numbers)].sort((a, b) => a - b);
}

describe('customer templates', () => {
  it.each(NOTIFICATION_KEYS)('has a template registered for %s', (key) => {
    expect(CUSTOMER_TEMPLATES[key]).toBeDefined();
  });

  it('gives every template as many variables as its body has placeholders', () => {
    // A mismatch is rejected by Meta at send time, not at submission time, so
    // it surfaces as a failed delivery rather than a failed deploy.
    for (const [key, template] of Object.entries(CUSTOMER_TEMPLATES)) {
      if (!template) continue;
      expect(
        template.variables.length,
        `${key}: body has ${placeholderCount(template.body)} placeholders but ${template.variables.length} variables`,
      ).toBe(placeholderCount(template.body));
    }
  });

  it('numbers placeholders from 1 with no gaps', () => {
    // Meta binds parameters positionally. A body that jumps from {{1}} to {{3}}
    // silently shifts every value after it.
    for (const [key, template] of Object.entries(CUSTOMER_TEMPLATES)) {
      if (!template) continue;
      const unique = placeholderNumbers(template.body);
      expect(unique, `${key} placeholders are not 1..n`).toEqual(
        unique.map((_value, index) => index + 1),
      );
    }
  });

  it('names every template the way Meta requires', () => {
    // Lowercase, digits and underscores only. Meta rejects anything else at
    // submission, which is discovered days later by whoever is waiting.
    for (const [key, template] of Object.entries(CUSTOMER_TEMPLATES)) {
      if (!template) continue;
      expect(template.name, `${key} has a name Meta will reject`).toMatch(/^[a-z0-9_]{1,512}$/);
    }
  });

  it('namespaces every template so one shop cannot collide with another', () => {
    for (const [key, template] of Object.entries(CUSTOMER_TEMPLATES)) {
      if (!template) continue;
      expect(template.name, `${key} is not namespaced`).toMatch(/^flowdesk_/);
    }
  });

  it('uses one template name per key', () => {
    const names = Object.values(CUSTOMER_TEMPLATES)
      .filter((template): template is NonNullable<typeof template> => Boolean(template))
      .map((template) => template.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('owner templates', () => {
  it('names and numbers them by the same rules', () => {
    for (const [kind, template] of Object.entries(OWNER_TEMPLATES)) {
      expect(template.name, `${kind} has a name Meta will reject`).toMatch(/^[a-z0-9_]{1,512}$/);
      expect(template.name, `${kind} is not namespaced`).toMatch(/^flowdesk_owner_/);

      const unique = placeholderNumbers(template.body);
      expect(unique, `${kind} placeholders are not 1..n`).toEqual(
        unique.map((_value, index) => index + 1),
      );
    }
  });
});
