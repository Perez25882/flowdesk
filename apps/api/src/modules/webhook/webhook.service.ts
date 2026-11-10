import { createHmac, timingSafeEqual } from 'node:crypto';
import { MessageType } from '../../types/prisma-enums.js';
import { env } from '../../config/env.js';
import type {
  MetaContact,
  MetaEchoMessage,
  MetaMedia,
  MetaMessage,
  MetaWebhookChange,
  MetaWebhookPayload,
  ParsedEchoMessage,
  ParsedIncomingMessage,
  WebhookVerificationParams,
} from './webhook.types.js';

const SIGNATURE_PREFIX = 'sha256=';
const MAX_TIMESTAMP_SECONDS = 253_402_300_799; // End of year 9999.

function parseSignature(signature: string): Buffer | null {
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return null;
  }

  const hexDigest = signature.slice(SIGNATURE_PREFIX.length);

  if (!/^[a-f0-9]{64}$/i.test(hexDigest)) {
    return null;
  }

  return Buffer.from(hexDigest, 'hex');
}

export function validateWebhookSignature(rawBody: Buffer, signature: string): boolean {
  // Without a shared secret the caller cannot be authenticated. Fail closed —
  // an unverified webhook must never reach the processing pipeline.
  if (!env.META_WEBHOOK_SECRET) {
    return false;
  }

  const receivedDigest = parseSignature(signature);

  if (!receivedDigest) {
    return false;
  }

  const expectedDigest = createHmac('sha256', env.META_WEBHOOK_SECRET).update(rawBody).digest();

  if (receivedDigest.length !== expectedDigest.length) {
    return false;
  }

  return timingSafeEqual(receivedDigest, expectedDigest);
}

export function extractMessageType(message: MetaMessage): MessageType {
  if (message.type === 'text') {
    return MessageType.TEXT;
  }

  if (message.type === 'image') {
    return MessageType.IMAGE;
  }

  if (message.type === 'audio') {
    return MessageType.AUDIO;
  }

  if (message.type === 'video') {
    return MessageType.VIDEO;
  }

  if (message.type === 'document') {
    return MessageType.DOCUMENT;
  }

  if (message.type === 'sticker') {
    return MessageType.STICKER;
  }

  if (message.type === 'reaction') {
    return MessageType.REACTION;
  }

  if (message.type === 'button') {
    return MessageType.BUTTON_REPLY;
  }

  if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
    return MessageType.BUTTON_REPLY;
  }

  if (message.type === 'interactive' && message.interactive.type === 'list_reply') {
    return MessageType.LIST_REPLY;
  }

  return MessageType.UNKNOWN;
}

function findContact(contacts: MetaContact[] | undefined, waId: string): MetaContact | undefined {
  return Array.isArray(contacts) ? contacts.find((contact) => contact?.wa_id === waId) : undefined;
}

function extractBody(message: MetaMessage): string | undefined {
  if (message.type === 'text') {
    return message.text.body;
  }

  if (message.type === 'image') {
    return message.image.caption;
  }

  if (message.type === 'video') {
    return message.video.caption;
  }

  if (message.type === 'document') {
    return message.document.caption;
  }

  if (message.type === 'button') {
    return message.button.text;
  }

  if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
    return message.interactive.button_reply.title;
  }

  if (message.type === 'interactive' && message.interactive.type === 'list_reply') {
    return message.interactive.list_reply.title;
  }

  return undefined;
}

function extractMedia(message: MetaMessage): ParsedIncomingMessage['media'] {
  let media: MetaMedia | undefined;
  let filename: string | undefined;

  if (message.type === 'image') {
    media = message.image;
  }

  if (message.type === 'audio') {
    media = message.audio;
  }

  if (message.type === 'video') {
    media = message.video;
  }

  if (message.type === 'document') {
    media = message.document;
    filename = message.document.filename;
  }

  if (message.type === 'sticker') {
    media = message.sticker;
  }

  if (!media) {
    return undefined;
  }

  return {
    id: media.id,
    mimeType: media.mime_type,
    sha256: media.sha256,
    caption: media.caption,
    filename,
  };
}

function extractReaction(message: MetaMessage): ParsedIncomingMessage['reaction'] {
  if (message.type !== 'reaction') {
    return undefined;
  }

  return {
    emoji: message.reaction.emoji,
    reactedToWaMessageId: message.reaction.message_id,
  };
}

function webhookChanges(payload: MetaWebhookPayload): MetaWebhookChange[] {
  if (!Array.isArray(payload?.entry)) return [];
  return payload.entry.flatMap((entry) =>
    Array.isArray(entry?.changes) ? entry.changes.filter((change) => change?.value) : [],
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 512 &&
    !value.includes('\0')
  );
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return seconds > 0 && seconds <= MAX_TIMESTAMP_SECONDS ? new Date(seconds * 1000) : null;
}

export function parseWebhookPayload(payload: MetaWebhookPayload): ParsedIncomingMessage[] {
  return webhookChanges(payload).flatMap((change) => {
    const phoneNumberId = change.value.metadata?.phone_number_id;
    if (
      change.field !== 'messages' ||
      !Array.isArray(change.value.messages) ||
      !isIdentifier(phoneNumberId)
    ) {
      return [];
    }

    return change.value.messages.flatMap((message) => {
      if (
        !isIdentifier(message?.id) ||
        typeof message.from !== 'string' ||
        !/\d/.test(message.from)
      ) {
        return [];
      }
      const timestamp = parseTimestamp(message.timestamp);
      if (!timestamp) return [];
      if (message.type === 'text' && typeof message.text?.body !== 'string') return [];

      const contact = findContact(change.value.contacts, message.from);
      const name = contact?.profile?.name;

      try {
        return [
          {
            businessPhoneNumberId: phoneNumberId,
            displayPhoneNumber: change.value.metadata.display_phone_number,
            waMessageId: message.id,
            from: message.from,
            profileName: typeof name === 'string' ? name : undefined,
            timestamp,
            type: extractMessageType(message),
            body: extractBody(message),
            media: extractMedia(message),
            reaction: extractReaction(message),
            // What they were replying to, when they were replying to anything.
            //
            // Meta sets `context.id` on a quoted reply and on a reply to a Status
            // the owner posted from the Business app. That second case is a whole
            // sales channel for Ghanaian shops — post the goods to Status, field
            // the replies — and it arrives here as a bare "how much?" unless this
            // id is carried through. It was in the payload all along and was being
            // dropped one line before it could be used.
            replyToWaId: isIdentifier(message.context?.id) ? message.context.id : null,
            rawPayload: message,
          },
        ];
      } catch {
        // A malformed member must not erase valid messages in the same batch.
        return [];
      }
    });
  });
}

/**
 * Extracts messages the owner sent from the WhatsApp Business app.
 *
 * Coexistence numbers mirror those sends back to us on `smb_message_echoes`.
 * Without this the dashboard would show the conversation as unanswered and the
 * assistant would reply on top of a human who had already handled it.
 */
export function parseEchoPayload(payload: MetaWebhookPayload): ParsedEchoMessage[] {
  return webhookChanges(payload).flatMap((change) => {
    if (
      change.field !== 'smb_message_echoes' ||
      !Array.isArray(change.value.message_echoes) ||
      !isIdentifier(change.value.metadata?.phone_number_id)
    ) {
      return [];
    }

    return change.value.message_echoes.flatMap((echo: MetaEchoMessage) => {
      // An echo with no recipient cannot be attributed to a conversation.
      if (!isIdentifier(echo?.id) || typeof echo.to !== 'string' || !/\d/.test(echo.to)) {
        return [];
      }
      const timestamp = parseTimestamp(echo.timestamp);
      if (!timestamp) return [];

      try {
        return [
          {
            businessPhoneNumberId: change.value.metadata.phone_number_id,
            displayPhoneNumber: change.value.metadata.display_phone_number,
            waMessageId: echo.id,
            to: echo.to,
            timestamp,
            type: extractMessageType(echo),
            body: extractBody(echo),
            rawPayload: echo,
          },
        ];
      } catch {
        return [];
      }
    });
  });
}

/**
 * Fields present in a delivery that nothing here consumes yet.
 *
 * Meta silently keeps sending a subscribed field forever, so an unhandled one
 * is invisible without this: the payload is dropped and no one finds out until
 * a feature that depends on it is reported broken. Logging the field names (and
 * the shape of their value, never the contents) is how the real schema for
 * `history` and `smb_app_state_sync` gets captured before writing a parser
 * against a guessed structure.
 */
const HANDLED_FIELDS = new Set(['messages', 'smb_message_echoes']);

export function describeUnhandledFields(
  payload: MetaWebhookPayload,
): Array<{ field: string; valueKeys: string[] }> {
  return webhookChanges(payload)
    .filter((change) => !HANDLED_FIELDS.has(change.field))
    .map((change) => ({
      field: change.field,
      valueKeys: Object.keys(change.value ?? {}),
    }));
}

export function handleVerification(params: WebhookVerificationParams): string | null {
  if (params.mode !== 'subscribe') {
    return null;
  }

  // Fail closed when unconfigured, otherwise an absent token on both sides
  // would compare equal and hand out a verified webhook subscription.
  if (!env.META_VERIFY_TOKEN || !params.token) {
    return null;
  }

  const expected = Buffer.from(env.META_VERIFY_TOKEN);
  const received = Buffer.from(params.token);

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return null;
  }

  return params.challenge;
}
