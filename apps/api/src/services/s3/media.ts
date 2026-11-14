import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// Constructed lazily so the process boots without AWS credentials. When media
// storage is unconfigured (local development), inbound media is still recorded
// on the Message row and still reviewed — see `archiveInboundMedia`.
let s3ClientInstance: S3Client | null = null;

function getS3Client(): S3Client {
  if (!features.mediaStorage) {
    throw new Error('Media storage is not configured (AWS_* environment variables missing)');
  }

  // `S3_ENDPOINT` points this same client at any S3-compatible bucket —
  // Supabase Storage, Cloudflare R2, MinIO. Those address objects path-style
  // (`<endpoint>/<bucket>/<key>`) rather than putting the bucket in the
  // hostname, so configuring an endpoint turns path-style on unless the
  // deployment says otherwise. Left empty, this is an ordinary AWS S3 client
  // and nothing about the previous behaviour changes.
  s3ClientInstance ??= new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    },
    ...(env.S3_ENDPOINT
      ? { endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE ?? true }
      : env.S3_FORCE_PATH_STYLE
        ? { forcePathStyle: true }
        : {}),
  });

  return s3ClientInstance;
}

export interface UploadResult {
  url: string;
  key: string;
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string,
  signal?: AbortSignal,
  metadata?: Record<string, string>,
): Promise<UploadResult> {
  const bucket = env.AWS_S3_BUCKET as string;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ...(metadata ? { Metadata: metadata } : {}),
    }), signal ? { abortSignal: signal } : undefined,
  );

  logger.info({ key, contentType, size: buffer.length }, 'Uploaded media to object storage');
  return { url: objectUrl(bucket, key), key };
}

/**
 * The object's address in the bucket.
 *
 * Recorded for diagnostics and for a possible future move to signed URLs; it is
 * never what a browser loads, because the bucket is private and the bytes are
 * streamed back through the API instead (see `getArchivedMedia`). A configured
 * endpoint is addressed path-style, matching the client above.
 */
function objectUrl(bucket: string, key: string): string {
  if (env.S3_ENDPOINT) {
    return `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

interface StoredMediaMetadata {
  url: string;
  contentType: string | undefined;
  size: number | undefined;
  metadata: Record<string, string> | undefined;
}

export async function inspectStoredMedia(key: string, signal: AbortSignal): Promise<StoredMediaMetadata | null> {
  if (!features.mediaStorage) return null;
  const bucket = env.AWS_S3_BUCKET as string;
  try {
    const result = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
    return { url: objectUrl(bucket, key), contentType: result.ContentType, size: result.ContentLength, metadata: result.Metadata };
  } catch {
    return null;
  }
}

/**
 * Removes an object.
 *
 * Used when the owner deletes a product photo. A failure is logged and
 * swallowed: the row is what the dashboard reads, and an orphaned object costs
 * a fraction of a pesewa, whereas a delete that appears to fail after the row
 * is already gone leaves the owner staring at a photo they just removed.
 */
export async function deleteObject(key: string): Promise<void> {
  if (!features.mediaStorage) return;

  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET as string, Key: key }),
    );
  } catch (error: unknown) {
    logger.error({ error, key }, 'Failed to remove an object from storage; it is now orphaned');
  }
}

export async function deleteProofObject(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET as string, Key: key }),
    { abortSignal: AbortSignal.timeout(8_000) });
}

/**
 * Where a message's media is archived.
 *
 * Derived from the WhatsApp message id rather than the clock, so reprocessing
 * the same message writes the same object instead of leaving a duplicate behind
 * on every retry — and so the key is a stable identifier the payments module can
 * use to recognise a screenshot it has already recorded a claim for.
 *
 * S3 keys are a flat namespace, so `..` does not traverse, but the components
 * are still restricted to a safe charset as defence in depth against a crafted
 * id steering the key outside the business's own prefix.
 */
export function mediaArchiveKey(businessId: string, waMessageId: string, mimeType: string): string {
  const safeMessageId = waMessageId.replace(/[^a-zA-Z0-9_-]/g, '');
  const extension = (mimeType.split('/')[1] ?? 'bin').replace(/[^a-zA-Z0-9]/g, '');
  return `businesses/${businessId}/media/${safeMessageId}.${extension}`;
}

/** Why an image is not in the bucket. Reported, never guessed at later. */
export type MediaArchiveFailure =
  | 'storage_not_configured'
  | 'no_tenant_credentials'
  | 'meta_rejected'
  | 'transfer_failed';

export type MediaArchiveResult =
  | { status: 'archived'; url: string; key: string; dimensions?: ImageDimensions }
  | { status: 'unavailable'; reason: MediaArchiveFailure };

export interface ImageDimensions {
  width: number;
  height: number;
}

export async function archiveInboundMedia(params: {
  mediaId: string;
  businessId: string;
  waMessageId: string;
  phoneNumberId: string;
  mimeType: string;
  key: string;
}): Promise<MediaArchiveResult> {
  if (!features.mediaStorage) return { status: 'unavailable', reason: 'storage_not_configured' };
  const { businessId, waMessageId, phoneNumberId, mediaId, mimeType, key } = params;
  const { archiveWhatsAppMedia, WhatsAppMediaError } = await import('../media/whatsapp-archive.js');
  try {
    const result = await archiveWhatsAppMedia({
      businessId, waMessageId, phoneNumberId, mediaId, mediaMime: mimeType, mediaDigest: null, type: 'IMAGE', key,
    });
    return { status: 'archived', url: result.url, key: result.key, ...(result.dimensions ? { dimensions: result.dimensions } : {}) };
  } catch (error) {
    if (error instanceof WhatsAppMediaError) {
      if (error.reason === 'MEDIA_CREDENTIALS_UNAVAILABLE') return { status: 'unavailable', reason: 'no_tenant_credentials' };
      if (error.reason === 'MEDIA_PROVIDER_REJECTED') return { status: 'unavailable', reason: 'meta_rejected' };
    }
    return { status: 'unavailable', reason: 'transfer_failed' };
  }
}

/**
 * Reads an image's pixel dimensions out of its header.
 *
 * Header-only on purpose: the screenshot heuristic wants the aspect ratio and
 * nothing else, and decoding the image to get it would cost a dependency and
 * real CPU on every inbound photo. Formats other than PNG and JPEG return null
 * and the caller simply scores without the signal.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegDimensions(buffer);
  }

  return null;
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] as number;
    // The start-of-frame markers carry the dimensions. C4, C8 and CC share the
    // range but are tables, not frames.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }

  return null;
}

export interface ArchivedMedia {
  body: Readable;
  contentType: string;
  contentLength?: number;
}

/**
 * Reads an archived object back out of the bucket.
 *
 * The dashboard cannot load the S3 URL directly — the objects are private and
 * nothing here signs URLs — so the image is served back through the API, which
 * already knows who is asking and which tenant they belong to.
 */
export async function getArchivedMedia(key: string): Promise<ArchivedMedia | null> {
  if (!features.mediaStorage) return null;

  try {
    const object = await getS3Client().send(
      new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET as string, Key: key }),
    );

    if (!object.Body) return null;

    return {
      body: object.Body as Readable,
      contentType: object.ContentType ?? 'application/octet-stream',
      ...(object.ContentLength !== undefined ? { contentLength: object.ContentLength } : {}),
    };
  } catch (error: unknown) {
    logger.error({ error, key }, 'Failed to read archived media from S3');
    return null;
  }
}
