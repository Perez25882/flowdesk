import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_TEMPLATES,
  type CustomerTemplate,
} from '../src/services/notifications/customer-notifications.js';
import {
  parseTemplateConfig,
  renderTemplate,
  type TemplateKey,
} from '../src/services/templates/template-engine.js';

// The table under test is data; the modules that carry it reach for Prisma and
// Redis at import time and neither is available here.
vi.mock('../src/config/database.js', () => ({ prisma: {} }));
vi.mock('../src/config/redis.js', () => ({ redis: {}, redisSubscriber: {} }));

/**
 * The two channels have to say the same thing.
 *
 * Inside the 24-hour window a customer gets the free-form wording from
 * `template-engine.ts`; outside it they get an approved Meta template, which is
 * a fixed string held in a different file and approved in a different system.
 * Nothing in the type system ties the two together, so this does: if either
 * side is reworded, an order confirmation starts saying two different things
 * depending on what time of day the owner confirmed it, and the operator has to
 * be told to resubmit the template.
 */

const EMPTY_CONFIG = parseTemplateConfig(null);

const VARIABLES: Record<string, string> = {
  name: 'Kwame',
  ref: 'FD-1042',
  business: 'Accra Rice Depot',
  amount: '640.00',
  // Deliberately not blank. A blank cancellation reason is the one case where
  // the two channels legitimately differ: Meta rejects an empty parameter, so
  // the template says "No reason was given." where the free-form text says
  // nothing at all.
  reason: 'The item is out of stock.',
  status: '',
  details: '',
};

function renderMetaBody(template: CustomerTemplate): string {
  return template.variables.reduce(
    (body, variable, index) => body.replaceAll(`{{${index + 1}}}`, VARIABLES[variable] ?? ''),
    template.body,
  );
}

describe('customer templates match the free-form wording', () => {
  for (const [key, template] of Object.entries(CUSTOMER_TEMPLATES) as Array<
    [TemplateKey, CustomerTemplate]
  >) {
    it(`${key} reads identically on both channels`, () => {
      expect(renderMetaBody(template)).toBe(renderTemplate(EMPTY_CONFIG, key, VARIABLES));
    });
  }
});

describe('customer templates are shaped the way Meta requires', () => {
  const templates = Object.values(CUSTOMER_TEMPLATES) as CustomerTemplate[];

  it('covers the notifications that can fire outside the window', () => {
    // The order lifecycle and the payment receipt are the only automated
    // messages not sent in direct response to an inbound one, so they are the
    // only ones that can find the window closed.
    expect(Object.keys(CUSTOMER_TEMPLATES).sort()).toEqual([
      'order_cancelled',
      'order_confirmed',
      'order_dispatched',
      'order_fulfilled',
      'order_pending',
      'order_processing',
      'payment_received',
    ]);
  });

  it('numbers its placeholders from 1 with no gaps', () => {
    for (const template of templates) {
      const placeholders = [...template.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) =>
        Number(match[1]),
      );
      expect(placeholders).toEqual(template.variables.map((_, index) => index + 1));
    }
  });

  it('never places two placeholders next to each other', () => {
    // Meta rejects a body where one variable abuts the next, because the
    // rendered text would run two values together with nothing between them.
    for (const template of templates) {
      expect(template.body).not.toMatch(/\}\}\s*\{\{/);
    }
  });

  it('gives every template a distinct name in the flowdesk namespace', () => {
    const names = templates.map((template) => template.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^flowdesk_[a-z_]+$/);
    }
  });
});
