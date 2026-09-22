import type { MessageType } from '@prisma/client';

export type MetaMessagingProduct = 'whatsapp';

export interface MetaWebhookPayload {
  object: 'whatsapp_business_account';
  entry: MetaWebhookEntry[];
}

export interface MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

/**
 * Webhook fields Flowdesk subscribes to.
 *
 * `smb_message_echoes` only arrives for numbers running WhatsApp Business app
 * coexistence: it mirrors messages the owner sent from their own phone, which
 * Flowdesk would otherwise never see.
 */
export type MetaWebhookField = 'messages' | 'smb_message_echoes' | string;

export interface MetaWebhookChange {
  field: MetaWebhookField;
  value: MetaWebhookValue;
}

export interface MetaWebhookValue {
  messaging_product: MetaMessagingProduct;
  metadata: MetaMetadata;
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaMessageStatus[];
  /** Present on `smb_message_echoes` deliveries only. */
  message_echoes?: MetaEchoMessage[];
}

/**
 * An echo of a message the business sent from the WhatsApp Business app.
 *
 * Shape matches a normal message except the counterparty is in `to` — `from`
 * is the business's own number, so it cannot be used to identify the customer.
 */
export type MetaEchoMessage = MetaMessage & { to: string };

export interface MetaMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface MetaContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export type MetaMessage =
  | MetaTextMessage
  | MetaImageMessage
  | MetaAudioMessage
  | MetaDocumentMessage
  | MetaStickerMessage
  | MetaReactionMessage
  | MetaVideoMessage
  | MetaButtonMessage
  | MetaInteractiveMessage;

export interface MetaBaseMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  context?: MetaMessageContext;
}

export interface MetaMessageContext {
  from?: string;
  id: string;
}

export interface MetaTextMessage extends MetaBaseMessage {
  type: 'text';
  text: {
    body: string;
  };
}

export interface MetaImageMessage extends MetaBaseMessage {
  type: 'image';
  image: MetaMedia;
}

export interface MetaAudioMessage extends MetaBaseMessage {
  type: 'audio';
  audio: MetaMedia;
}

export interface MetaDocumentMessage extends MetaBaseMessage {
  type: 'document';
  document: MetaDocumentMedia;
}

export interface MetaStickerMessage extends MetaBaseMessage {
  type: 'sticker';
  sticker: MetaStickerMedia;
}

export interface MetaReactionMessage extends MetaBaseMessage {
  type: 'reaction';
  reaction: {
    message_id: string;
    emoji: string;
  };
}

export interface MetaVideoMessage extends MetaBaseMessage {
  type: 'video';
  video: MetaMedia;
}

export interface MetaButtonMessage extends MetaBaseMessage {
  type: 'button';
  button: {
    payload: string;
    text: string;
  };
}

export interface MetaInteractiveMessage extends MetaBaseMessage {
  type: 'interactive';
  interactive: MetaInteractive;
}

export interface MetaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

export interface MetaDocumentMedia extends MetaMedia {
  filename?: string;
}

export interface MetaStickerMedia extends MetaMedia {
  animated?: boolean;
}

export type MetaInteractive =
  | {
      type: 'button_reply';
      button_reply: {
        id: string;
        title: string;
      };
    }
  | {
      type: 'list_reply';
      list_reply: {
        id: string;
        title: string;
        description?: string;
      };
    };

export interface MetaMessageStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    expiration_timestamp?: string;
    origin?: {
      type: string;
    };
  };
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string;
  };
  errors?: MetaWebhookError[];
}

export interface MetaWebhookError {
  code: number;
  title: string;
  message?: string;
  error_data?: {
    details: string;
  };
}

export interface ParsedIncomingMessage {
  businessPhoneNumberId: string;
  displayPhoneNumber: string;
  waMessageId: string;
  from: string;
  profileName?: string | undefined;
  timestamp: Date;
  type: MessageType;
  body?: string | undefined;
  media?: {
    id: string;
    mimeType?: string | undefined;
    sha256?: string | undefined;
    caption?: string | undefined;
    filename?: string | undefined;
  } | undefined;
  reaction?: {
    emoji: string;
    reactedToWaMessageId: string;
  } | undefined;
  /**
   * The message being replied to, from Meta's `context.id`. Null when the
   * customer wrote a fresh message rather than replying to something.
   *
   * Carried across the queue rather than re-read from `rawPayload`, so the
   * worker never has to know the shape of Meta's envelope.
   */
  replyToWaId: string | null;
  rawPayload: MetaMessage;
}

/**
 * A message the owner sent from their own phone, mirrored back to us.
 *
 * `to` is the customer's WhatsApp id — the inverse of {@link ParsedIncomingMessage},
 * where the customer is in `from`.
 */
export interface ParsedEchoMessage {
  businessPhoneNumberId: string;
  displayPhoneNumber: string;
  waMessageId: string;
  to: string;
  timestamp: Date;
  type: MessageType;
  body?: string | undefined;
  rawPayload: MetaEchoMessage;
}

export interface WebhookVerificationParams {
  mode: string;
  token: string;
  challenge: string;
}
