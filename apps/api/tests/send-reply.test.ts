import { describe, expect, it } from 'vitest';
import { SendReplySchema } from '../src/modules/messages/messages.schema.js';
import { shouldSendAutoReply } from '../src/services/templates/template-engine.js';
import { hasCapability } from '@flowdesk/shared';

/**
 * Replying from the dashboard.
 *
 * The rules that decide whether a reply can be sent are checked synchronously,
 * before the job is queued, because the failure mode otherwise is invisible: the
 * API answers 200, Meta rejects the send as non-retryable, the job dead-letters,
 * and the owner is never told their message did not arrive.
 */
describe('SendReplySchema', () => {
  it('accepts an ordinary reply', () => {
    expect(SendReplySchema.safeParse({ body: 'We have it in stock.' }).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const parsed = SendReplySchema.parse({ body: '  hello  ' });
    expect(parsed.body).toBe('hello');
  });

  it('rejects an empty or whitespace-only body', () => {
    expect(SendReplySchema.safeParse({ body: '' }).success).toBe(false);
    expect(SendReplySchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('rejects a body longer than WhatsApp accepts', () => {
    // 4096 is Meta's limit. Rejecting here turns a silent delivery failure into
    // an error the owner can see.
    expect(SendReplySchema.safeParse({ body: 'a'.repeat(4096) }).success).toBe(true);
    expect(SendReplySchema.safeParse({ body: 'a'.repeat(4097) }).success).toBe(false);
  });
});

describe('service window applies to human replies too', () => {
  it('is closed when the customer has never messaged in', () => {
    // The owner cannot open a conversation with a free-form message; only a
    // customer message opens the window.
    expect(shouldSendAutoReply(null).withinWindow).toBe(false);
  });

  it('is open shortly after a customer message', () => {
    expect(shouldSendAutoReply(new Date(Date.now() - 60_000)).withinWindow).toBe(true);
  });

  it('is closed a day later', () => {
    expect(
      shouldSendAutoReply(new Date(Date.now() - 25 * 60 * 60 * 1000)).withinWindow,
    ).toBe(false);
  });
});

describe('messages.send capability', () => {
  it('is held by the owner', () => {
    expect(hasCapability(undefined, 'messages.send')).toBe(true);
  });

  it('is held by managers and counter staff', () => {
    expect(hasCapability('MANAGER', 'messages.send')).toBe(true);
    expect(hasCapability('OPERATIONS', 'messages.send')).toBe(true);
  });

  it('is NOT held by delivery riders', () => {
    // A rider account is the one most likely to be on a borrowed or lost phone;
    // it must not be able to speak to customers as the business.
    expect(hasCapability('DELIVERY', 'messages.send')).toBe(false);
  });

  it('is distinct from relabelling an intent', () => {
    // Reusing `messages.write` for sending would have granted this silently to
    // everyone who can correct a classification.
    expect(hasCapability('DELIVERY', 'messages.write')).toBe(false);
    expect(hasCapability('OPERATIONS', 'messages.write')).toBe(true);
  });
});
