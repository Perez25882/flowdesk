import { describe, expect, test } from 'vitest';
import { parseEchoPayload, parseWebhookPayload } from '../src/modules/webhook/webhook.service.js';
import type { MetaWebhookPayload } from '../src/modules/webhook/webhook.types.js';

/**
 * Coexistence echoes are the only signal that the owner replied from their own
 * phone. Parsing them wrongly is silent: the assistant simply talks over the
 * owner, which is why the negative cases below matter as much as the happy one.
 */

function payload(field: string, value: Record<string, unknown>): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'entry-1', changes: [{ field, value: value as never }] }],
  } as MetaWebhookPayload;
}

const METADATA = { display_phone_number: '233205464182', phone_number_id: '1104754576062818' };

function echoValue(overrides: Record<string, unknown> = {}) {
  return {
    messaging_product: 'whatsapp',
    metadata: METADATA,
    message_echoes: [
      {
        from: '233205464182',
        to: '233558425882',
        id: 'wamid.ECHO1',
        timestamp: '1786000000',
        type: 'text',
        text: { body: 'Yes we have it in stock, come by at 4pm' },
        ...overrides,
      },
    ],
  };
}

describe('parseEchoPayload', () => {
  test('extracts a message the owner sent from the WhatsApp Business app', () => {
    const result = parseEchoPayload(payload('smb_message_echoes', echoValue()));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      businessPhoneNumberId: '1104754576062818',
      waMessageId: 'wamid.ECHO1',
      to: '233558425882',
      body: 'Yes we have it in stock, come by at 4pm',
    });
  });

  test('converts the unix timestamp to a Date', () => {
    const result = parseEchoPayload(payload('smb_message_echoes', echoValue()));

    expect(result[0]?.timestamp).toEqual(new Date(1786000000 * 1000));
  });

  test('ignores echoes with no recipient, which cannot be attributed', () => {
    const result = parseEchoPayload(payload('smb_message_echoes', echoValue({ to: undefined })));

    expect(result).toEqual([]);
  });

  test('ignores ordinary inbound message deliveries', () => {
    const inbound = payload('messages', {
      messaging_product: 'whatsapp',
      metadata: METADATA,
      messages: [
        { from: '233558425882', id: 'wamid.IN1', timestamp: '1786000000', type: 'text', text: { body: 'hi' } },
      ],
    });

    expect(parseEchoPayload(inbound)).toEqual([]);
  });

  test('returns nothing when the field carries no echoes', () => {
    const result = parseEchoPayload(
      payload('smb_message_echoes', { messaging_product: 'whatsapp', metadata: METADATA }),
    );

    expect(result).toEqual([]);
  });
});

describe('parseWebhookPayload', () => {
  test('does not treat an echo as an inbound customer message', () => {
    // Without this the owner's own words would be classified as a customer
    // request and could raise a duplicate order.
    const result = parseWebhookPayload(payload('smb_message_echoes', echoValue()));

    expect(result).toEqual([]);
  });
});
