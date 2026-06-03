import type { MetaWebhookPayload } from '../../src/modules/webhook/webhook.types.js';

export const textMessagePayload: MetaWebhookPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'whatsapp-business-account-id',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '233200000000',
              phone_number_id: 'phone-number-id-1',
            },
            contacts: [
              {
                profile: {
                  name: 'Kwame Mensah',
                },
                wa_id: '233244123456',
              },
            ],
            messages: [
              {
                from: '233244123456',
                id: 'wamid.abcdefghijklmnopqrstuvwxyz1',
                timestamp: '1714000000',
                type: 'text',
                text: {
                  body: 'Hello, I want to order 2 bags of rice',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const imageMessagePayload: MetaWebhookPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'whatsapp-business-account-id',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '233200000000',
              phone_number_id: 'phone-number-id-1',
            },
            contacts: [
              {
                profile: {
                  name: 'Ama Owusu',
                },
                wa_id: '233244654321',
              },
            ],
            messages: [
              {
                from: '233244654321',
                id: 'wamid.abcdefghijklmnopqrstuvwxyz2',
                timestamp: '1714000001',
                type: 'image',
                image: {
                  id: 'media-id-1',
                  mime_type: 'image/jpeg',
                  sha256: 'abcdef123456',
                  caption: 'Here is my MoMo payment screenshot',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const duplicateMessagePayload: MetaWebhookPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'whatsapp-business-account-id',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '233200000000',
              phone_number_id: 'phone-number-id-1',
            },
            contacts: [
              {
                profile: {
                  name: 'Kwame Mensah',
                },
                wa_id: '233244123456',
              },
            ],
            messages: [
              {
                from: '233244123456',
                id: 'wamid.abcdefghijklmnopqrstuvwxyz1',
                timestamp: '1714000000',
                type: 'text',
                text: {
                  body: 'Hello, I want to order 2 bags of rice',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const verificationGetParams = {
  'hub.mode': 'subscribe',
  'hub.verify_token': 'correct-verify-token',
  'hub.challenge': 'challenge-string-from-meta',
};

export const invalidVerificationGetParams = {
  'hub.mode': 'subscribe',
  'hub.verify_token': 'wrong-verify-token',
  'hub.challenge': 'challenge-string-from-meta',
};

export const invalidSignatureHeader = 'sha256=invalidsignature';
