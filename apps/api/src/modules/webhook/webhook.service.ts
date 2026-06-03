import { createHmac, timingSafeEqual } from 'node:crypto';
import { MessageType } from '../../types/prisma-enums.js';
import { env } from '../../config/env.js';
import type {
  MetaContact,
  MetaMedia,
  MetaMessage,
  MetaWebhookPayload,
  ParsedIncomingMessage,
  WebhookVerificationParams,
} from './webhook.types.js';

const SIGNATURE_PREFIX = 'sha256=';

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
  return contacts?.find((contact) => contact.wa_id === waId);
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

export function parseWebhookPayload(payload: MetaWebhookPayload): ParsedIncomingMessage[] {
  return payload.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => {
      if (change.field !== 'messages' || !change.value.messages) {
        return [];
      }

      return change.value.messages.map((message) => {
        const contact = findContact(change.value.contacts, message.from);

        return {
          businessPhoneNumberId: change.value.metadata.phone_number_id,
          displayPhoneNumber: change.value.metadata.display_phone_number,
          waMessageId: message.id,
          from: message.from,
          profileName: contact?.profile.name,
          timestamp: new Date(Number(message.timestamp) * 1000),
          type: extractMessageType(message),
          body: extractBody(message),
          media: extractMedia(message),
          reaction: extractReaction(message),
          rawPayload: message,
        };
      });
    }),
  );
}

export function handleVerification(params: WebhookVerificationParams): string | null {
  if (params.mode !== 'subscribe') {
    return null;
  }

  if (params.token !== env.META_VERIFY_TOKEN) {
    return null;
  }

  return params.challenge;
}
