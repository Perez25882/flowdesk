import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { loadTenantCredentials } from '../whatsapp/client.js';

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
): Promise<UploadResult> {
  const bucket = env.AWS_S3_BUCKET as string;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
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

/**
 * Meta's media URLs live about five minutes, and there is no second copy: if
 * the transfer fails, that image is gone for good and the customer has to be
 * asked to send it again. A short bounded retry is therefore worth it for the
 * failures that are plausibly transient — a dropped connection, an S3 5xx —
 * and pointless for the ones that are not (no credentials, Meta refusing the
 * id). Three attempts inside a few seconds sits comfortably within the window
 * without holding a worker slot open long enough to matter.
 *
 * Retrying at the job level instead would be worse: the job also enqueues intent
 * classification, and making an S3 outage replay that is a much larger blast
 * radius than losing one image.
 */
const ARCHIVE_ATTEMPTS = 3;
const ARCHIVE_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches inbound media from Meta with the owning business's own credentials
 * and archives it to S3 under `key`.
 *
 * Returns a result rather than throwing: archival failing must never stop the
 * message being recorded or reviewed. The caller decides what to tell the owner.
 */
export async function archiveInboundMedia(params: {
  mediaId: string;
  businessId: string;
  mimeType: string;
  key: string;
}): Promise<MediaArchiveResult> {
  const { mediaId, businessId, mimeType, key } = params;

  if (!features.mediaStorage) {
    logger.warn(
      { mediaId, businessId },
      'Media storage not configured — inbound media recorded and reviewed but not archived',
    );
    return { status: 'unavailable', reason: 'storage_not_configured' };
  }

  // Media is fetched with the credentials of the business the message belongs
  // to, matching how outbound sending works (`whatsapp/client.ts`). This used
  // to use the single global `META_ACCESS_TOKEN`, which broke tenant isolation
  // — every business's inbound media travelled on one shared credential — and
  // also meant a deployment with only per-tenant tokens archived nothing,
  // because `features.whatsapp` is false without the global var.
  const credentials = await loadTenantCredentials(businessId);

  if (!credentials) {
    logger.warn(
      { mediaId, businessId },
      'Business has no connected WhatsApp number — cannot fetch media from Meta',
    );
    return { status: 'unavailable', reason: 'no_tenant_credentials' };
  }

  let lastFailure: MediaArchiveFailure = 'transfer_failed';

  for (let attempt = 1; attempt <= ARCHIVE_ATTEMPTS; attempt += 1) {
    const outcome = await attemptArchive(mediaId, credentials.accessToken, mimeType, key);

    if (outcome.status === 'archived') {
      return outcome;
    }

    lastFailure = outcome.reason;

    // Meta refusing the id means the URL has expired or the id is not ours.
    // Asking again cannot change that answer.
    if (outcome.reason === 'meta_rejected' || attempt === ARCHIVE_ATTEMPTS) {
      break;
    }

    await sleep(ARCHIVE_RETRY_DELAY_MS * attempt);
  }

  logger.error(
    { mediaId, businessId, key, reason: lastFailure },
    'Inbound media could not be archived — the Meta URL has expired and the image is unrecoverable',
  );
  return { status: 'unavailable', reason: lastFailure };
}

async function attemptArchive(
  mediaId: string,
  accessToken: string,
  mimeType: string,
  key: string,
): Promise<MediaArchiveResult> {
  try {
    const metaUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${mediaId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaResponse.ok) {
      logger.error(
        { status: metaResponse.status, mediaId },
        'Failed to fetch media URL from Meta API',
      );
      // A 5xx from Graph is worth another go; anything else is a settled answer.
      return {
        status: 'unavailable',
        reason: metaResponse.status >= 500 ? 'transfer_failed' : 'meta_rejected',
      };
    }

    const metaData = (await metaResponse.json()) as { url?: string };
    const downloadUrl = metaData.url;

    if (!downloadUrl) {
      logger.error({ mediaId }, 'Meta API did not return download URL');
      return { status: 'unavailable', reason: 'meta_rejected' };
    }

    const downloadResponse = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!downloadResponse.ok) {
      logger.error(
        { status: downloadResponse.status, mediaId },
        'Failed to download media from Meta',
      );
      return {
        status: 'unavailable',
        reason: downloadResponse.status >= 500 ? 'transfer_failed' : 'meta_rejected',
      };
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const uploaded = await uploadBufferToS3(buffer, key, mimeType);
    const dimensions = readImageDimensions(buffer);

    return {
      status: 'archived',
      url: uploaded.url,
      key: uploaded.key,
      ...(dimensions ? { dimensions } : {}),
    };
  } catch (error: unknown) {
    logger.error({ error, mediaId }, 'Error downloading/uploading media');
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
