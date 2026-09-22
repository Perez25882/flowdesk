import { logger } from '../../config/logger.js';
import { getArchivedMedia } from '../s3/media.js';
import {
  MetaMediaUploadError,
  uploadMediaToMeta,
  type TenantCredentials,
} from './client.js';
import * as imageRepository from '../../modules/products/product-images.repository.js';

/**
 * Meta keeps an uploaded media object for 30 days. The cache is expired a good
 * deal earlier than that so a photo is never sent with an id that turns out to
 * have lapsed mid-flight — the cost of being early is one extra upload a
 * fortnight per photo, and the cost of being late is a customer who asked for a
 * picture and got an error.
 */
const MEDIA_ID_TTL_MS = 20 * 24 * 60 * 60 * 1000;

/**
 * Turns a stored product photo into a media id this tenant's number can send.
 *
 * Cached against the phone number that uploaded it, because a media id is
 * scoped to that number: a business that reconnects on a different one holds a
 * cached id that is not stale but simply wrong, and sending it would fail in a
 * way that looks like Meta being broken.
 *
 * Returns null rather than throwing. A photo failing to upload must not take
 * the reply down with it — the customer is better served by the sentence
 * arriving without the picture than by neither arriving.
 */
export async function resolveProductImageMediaId(
  credentials: TenantCredentials,
  imageId: string,
): Promise<string | null> {
  const cached = await imageRepository.findCachedMetaMedia(imageId);

  if (
    cached &&
    cached.waMediaPhoneNumberId === credentials.phoneNumberId &&
    Date.now() - cached.waMediaUploadedAt.getTime() < MEDIA_ID_TTL_MS
  ) {
    return cached.waMediaId;
  }

  const image = await imageRepository.findImageById(imageId, credentials.businessId);
  if (!image) {
    logger.warn(
      { imageId, businessId: credentials.businessId },
      'Cannot send product photo: the image does not belong to this business',
    );
    return null;
  }

  const stored = await getArchivedMedia(image.key);
  if (!stored) {
    logger.error({ imageId, key: image.key }, 'Cannot send product photo: object not in storage');
    return null;
  }

  const buffer = await readStream(stored);
  if (!buffer) return null;

  try {
    const mediaId = await uploadMediaToMeta(credentials, buffer, image.mimeType);
    await imageRepository.recordMetaMedia(imageId, mediaId, credentials.phoneNumberId);
    return mediaId;
  } catch (error: unknown) {
    if (error instanceof MetaMediaUploadError && cached) {
      // The upload we attempted was the replacement for a cached id; if that
      // cached id was the reason we got here, it is now known bad.
      await imageRepository.clearMetaMedia(imageId, cached.waMediaId);
    }
    logger.error(
      { error, imageId, businessId: credentials.businessId },
      'Failed to upload a product photo to Meta',
    );
    return null;
  }
}

/**
 * Drains the object body into a buffer.
 *
 * The whole file is held in memory because Meta's media upload is multipart and
 * needs a known length; at a 5 MB cap and one photo per message this is bounded
 * and small. Errors are caught rather than propagated for the same reason the
 * caller returns null: a photo is an enhancement to a reply, never the reply.
 */
async function readStream(stored: { body: NodeJS.ReadableStream }): Promise<Buffer | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stored.body) {
      // A Node stream yields Buffers unless an encoding was set on it, which
      // nothing here does; the string branch is handled rather than asserted
      // away so a stream configured elsewhere cannot corrupt the bytes silently.
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error: unknown) {
    logger.error({ error }, 'Failed to read a product photo out of storage');
    return null;
  }
}
