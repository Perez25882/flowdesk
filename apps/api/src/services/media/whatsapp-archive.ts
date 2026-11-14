import { createHash } from 'node:crypto';
import type { MessageType } from '@prisma/client';
import { env, features } from '../../config/env.js';
import { loadTenantCredentials } from '../whatsapp/client.js';
import {
  inspectStoredMedia,
  readImageDimensions,
  uploadBufferToS3,
  type ImageDimensions,
} from '../s3/media.js';
import { sniffImageType } from './image-file.js';

type MediaFailure =
  | 'MEDIA_TIMEOUT'
  | 'MEDIA_PROVIDER_UNAVAILABLE'
  | 'MEDIA_CREDENTIALS_UNAVAILABLE'
  | 'MEDIA_STORAGE_UNAVAILABLE'
  | 'MEDIA_UNSUPPORTED'
  | 'MEDIA_INVALID'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_PROVIDER_REJECTED';

export class WhatsAppMediaError extends Error {
  constructor(readonly reason: MediaFailure) {
    super(reason);
  }
}

const MB = 1024 * 1024;
const formats: Partial<Record<MessageType, { types: readonly string[]; limit: number }>> = {
  IMAGE: { types: ['image/jpeg', 'image/png'], limit: 5 * MB },
  AUDIO: {
    types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
    limit: 16 * MB,
  },
  DOCUMENT: { types: ['application/pdf', 'text/plain'], limit: 100 * MB },
  VIDEO: { types: ['video/mp4', 'video/3gpp'], limit: 16 * MB },
  STICKER: { types: ['image/webp'], limit: 500 * 1024 },
};

export function isWhatsAppArchiveMime(value: string): boolean {
  return Object.values(formats).some((policy) => policy.types.includes(value));
}

function mime(value: unknown): string | null {
  return typeof value === 'string' ? value.split(';')[0]!.trim().toLowerCase() : null;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const size = response.headers.get('content-length');
  if (size !== null && Number(size) > limit) {
    await response.body?.cancel();
    throw new WhatsAppMediaError('MEDIA_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WhatsAppMediaError('MEDIA_INVALID');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new WhatsAppMediaError('MEDIA_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!total || (size !== null && Number(size) !== total))
    throw new WhatsAppMediaError('MEDIA_INVALID');
  return Buffer.concat(chunks, total);
}

function matchesBytes(bytes: Buffer, type: string): boolean {
  if (type.startsWith('image/')) return sniffImageType(bytes) === type;
  if (type === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'text/plain') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
    } catch {
      return false;
    }
  }
  if (type === 'audio/ogg')
    return (
      bytes.subarray(0, 4).toString() === 'OggS' && bytes.subarray(0, 256).includes('OpusHead')
    );
  if (type === 'audio/amr') return bytes.subarray(0, 6).toString() === '#!AMR\n';
  if (type === 'audio/mpeg' && bytes.subarray(0, 3).toString() === 'ID3') return true;
  if (type === 'audio/mpeg' || type === 'audio/aac')
    return bytes.length > 3 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
  return bytes.length > 12 && bytes.subarray(4, 8).toString() === 'ftyp';
}

async function providerGet(url: URL, token: string, signal: AbortSignal): Promise<Response> {
  const result = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
    signal,
  });
  if (result.ok) return result;
  await result.body?.cancel();
  if (result.status === 429 || result.status >= 500)
    throw new WhatsAppMediaError('MEDIA_PROVIDER_UNAVAILABLE');
  if (result.status === 401 || result.status === 403)
    throw new WhatsAppMediaError('MEDIA_CREDENTIALS_UNAVAILABLE');
  throw new WhatsAppMediaError(
    result.status >= 300 && result.status < 400 ? 'MEDIA_INVALID' : 'MEDIA_PROVIDER_REJECTED',
  );
}

function digestMatches(digest: Buffer, declared: unknown): boolean {
  return (
    declared === null ||
    declared === undefined ||
    (typeof declared === 'string' &&
      (declared === digest.toString('base64') || declared.toLowerCase() === digest.toString('hex')))
  );
}

export interface WhatsAppMediaInput {
  businessId: string;
  phoneNumberId: string;
  waMessageId: string;
  type: MessageType;
  mediaId: string;
  mediaMime: string | null;
  mediaDigest: string | null;
}

export function whatsappMediaKey(
  input: Pick<WhatsAppMediaInput, 'businessId' | 'phoneNumberId' | 'waMessageId'>,
): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([input.phoneNumberId, input.waMessageId]))
    .digest('hex');
  return `businesses/${input.businessId}/media/whatsapp-${identity}`;
}

export async function archiveWhatsAppMedia(
  input: WhatsAppMediaInput & { key: string; recoverStored?: boolean },
): Promise<{ key: string; url: string; mime: string; dimensions: ImageDimensions | null }> {
  const policy = formats[input.type];
  const declared = mime(input.mediaMime);
  if (!policy || (declared && !policy.types.includes(declared)))
    throw new WhatsAppMediaError('MEDIA_UNSUPPORTED');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.mediaId)) throw new WhatsAppMediaError('MEDIA_INVALID');
  if (!features.mediaStorage) throw new WhatsAppMediaError('MEDIA_STORAGE_UNAVAILABLE');
  if (input.recoverStored && input.mediaDigest && input.key === whatsappMediaKey(input)) {
    const stored = await inspectStoredMedia(input.key, AbortSignal.timeout(3_000));
    const storedDigest = stored?.metadata?.['wa-sha256'];
    if (
      stored?.contentType &&
      policy.types.includes(stored.contentType) &&
      (!declared || declared === stored.contentType) &&
      stored.size &&
      stored.size <= policy.limit &&
      storedDigest &&
      /^[0-9a-f]{64}$/.test(storedDigest) &&
      digestMatches(Buffer.from(storedDigest, 'hex'), input.mediaDigest)
    ) {
      const width = Number(stored.metadata?.['wa-width']);
      const height = Number(stored.metadata?.['wa-height']);
      const dimensions =
        Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
          ? { width, height }
          : null;
      return { key: input.key, url: stored.url, mime: stored.contentType, dimensions };
    }
  }
  const credentials = await loadTenantCredentials(input.businessId);
  if (!credentials || credentials.phoneNumberId !== input.phoneNumberId)
    throw new WhatsAppMediaError('MEDIA_CREDENTIALS_UNAVAILABLE');

  const signal = AbortSignal.timeout(12_000);
  let bytes: Buffer;
  let actual: string;
  let digest: Buffer;
  try {
    const lookup = new URL(`https://graph.facebook.com/${env.META_API_VERSION}/${input.mediaId}`);
    lookup.searchParams.set('phone_number_id', input.phoneNumberId);
    const metadata = JSON.parse(
      (
        await readBounded(await providerGet(lookup, credentials.accessToken, signal), 16 * 1024)
      ).toString(),
    ) as {
      url?: string;
      id?: string;
      mime_type?: string;
      file_size?: number;
      sha256?: string;
    };
    if (
      !metadata ||
      (metadata.id !== undefined && metadata.id !== input.mediaId) ||
      typeof metadata.url !== 'string'
    )
      throw new WhatsAppMediaError('MEDIA_INVALID');
    const url = new URL(metadata.url);
    if (
      url.origin !== 'https://lookaside.fbsbx.com' ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/whatsapp_business/attachments/')
    )
      throw new WhatsAppMediaError('MEDIA_INVALID');
    if (typeof metadata.file_size === 'number' && metadata.file_size > policy.limit)
      throw new WhatsAppMediaError('MEDIA_TOO_LARGE');
    const response = await providerGet(url, credentials.accessToken, signal);
    const responseMime = mime(response.headers.get('content-type'));
    const providerMime = mime(metadata.mime_type);
    actual = providerMime ?? responseMime ?? '';
    if (
      !policy.types.includes(actual) ||
      (declared && declared !== actual) ||
      (responseMime && responseMime !== 'application/octet-stream' && responseMime !== actual)
    ) {
      await response.body?.cancel();
      throw new WhatsAppMediaError('MEDIA_UNSUPPORTED');
    }
    bytes = await readBounded(response, policy.limit);
    digest = createHash('sha256').update(bytes).digest();
    if (
      !matchesBytes(bytes, actual) ||
      !digestMatches(digest, input.mediaDigest) ||
      !digestMatches(digest, metadata.sha256) ||
      (typeof metadata.file_size === 'number' && metadata.file_size !== bytes.length)
    )
      throw new WhatsAppMediaError('MEDIA_INVALID');
  } catch (error: unknown) {
    if (error instanceof WhatsAppMediaError) throw error;
    if (signal.aborted) throw new WhatsAppMediaError('MEDIA_TIMEOUT');
    if (
      error instanceof SyntaxError ||
      (error instanceof TypeError && error.message === 'Invalid URL')
    )
      throw new WhatsAppMediaError('MEDIA_INVALID');
    throw new WhatsAppMediaError('MEDIA_PROVIDER_UNAVAILABLE');
  }

  const key = input.key;
  try {
    const dimensions = readImageDimensions(bytes);
    const stored = await uploadBufferToS3(bytes, key, actual, AbortSignal.timeout(10_000), {
      'wa-sha256': digest.toString('hex'),
      ...(dimensions
        ? { 'wa-width': String(dimensions.width), 'wa-height': String(dimensions.height) }
        : {}),
    });
    return { ...stored, mime: actual, dimensions };
  } catch {
    throw new WhatsAppMediaError('MEDIA_STORAGE_UNAVAILABLE');
  }
}
