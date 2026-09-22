import { randomUUID } from 'node:crypto';
import { features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  deleteObject,
  getArchivedMedia,
  uploadBufferToS3,
  type ArchivedMedia,
} from '../../services/s3/media.js';
import { describeRejection, inspectImageUpload } from '../../services/media/image-file.js';
import * as productRepository from './products.repository.js';
import * as repository from './product-images.repository.js';

/**
 * How many photos one product may carry.
 *
 * Not a storage limit — six 5 MB photos is pennies. It is a WhatsApp limit in
 * disguise: a customer who asks "do you have it in black" and receives nine
 * images has been spammed, and an owner who can upload nine will. Six covers
 * front, back, label, and the flaws a second-hand piece has to show honestly.
 */
export const MAX_IMAGES_PER_PRODUCT = 6;

export interface ProductImageView {
  id: string;
  position: number;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /**
   * Where the dashboard fetches the bytes from, relative to the API base.
   *
   * A path rather than a URL, and deliberately not something an `<img src>` can
   * load: the access token lives in memory, so the browser's own image request
   * would carry no Authorization header and come back 401. The dashboard reads
   * it through the API client and wraps the result in a Blob URL, exactly as it
   * already does for payment screenshots.
   */
  path: string;
  createdAt: Date;
}

export function toView(row: repository.ProductImageRow): ProductImageView {
  return {
    id: row.id,
    position: row.position,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    path: `/products/${row.productId}/images/${row.id}/file`,
    createdAt: row.createdAt,
  };
}

export async function listImages(
  productId: string,
  businessId: string,
): Promise<ProductImageView[]> {
  await requireProduct(productId, businessId);
  const rows = await repository.listImagesForProduct(productId, businessId);
  return rows.map(toView);
}

/**
 * Stores a photo against a product.
 *
 * The object is written before the row, and the object is removed again if the
 * row cannot be written. The other order would be worse: a row pointing at a
 * key that does not exist renders as a broken image in the owner's catalogue
 * and there is nothing they can do about it, whereas the failure handled here
 * leaves the catalogue exactly as it was.
 */
export async function addImage(
  productId: string,
  businessId: string,
  encoded: string,
): Promise<ProductImageView> {
  await requireProduct(productId, businessId);

  if (!features.mediaStorage) {
    throw new ValidationError(
      'Photo storage is not set up on this deployment yet, so the photo could not be saved.',
    );
  }

  const existing = await repository.countImagesForProduct(productId, businessId);
  if (existing >= MAX_IMAGES_PER_PRODUCT) {
    throw new ValidationError(
      `A product can have ${MAX_IMAGES_PER_PRODUCT} photos. Remove one before adding another.`,
    );
  }

  const inspection = inspectImageUpload(encoded);
  if (!inspection.ok) {
    throw new ValidationError(describeRejection(inspection.reason));
  }

  const { buffer, mimeType, sizeBytes, dimensions } = inspection.image;
  const key = imageKey(businessId, productId, mimeType);

  await uploadBufferToS3(buffer, key, mimeType);

  try {
    const row = await repository.createImage({
      businessId,
      productId,
      key,
      mimeType,
      sizeBytes,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      position: await repository.nextPosition(productId, businessId),
    });
    return toView(row);
  } catch (error: unknown) {
    logger.error({ error, productId, key }, 'Product image row failed after the object was written');
    await deleteObject(key);
    throw error;
  }
}

export async function removeImage(
  productId: string,
  imageId: string,
  businessId: string,
): Promise<void> {
  const image = await repository.findImageById(imageId, businessId);
  if (!image || image.productId !== productId) {
    throw new NotFoundError('That photo is not on this product');
  }

  await repository.deleteImage(imageId, businessId);
  await deleteObject(image.key);

  // Deleting the first photo promotes the next one, so the strip never starts
  // at position 1 and the assistant's "send the first image" stays meaningful.
  const remaining = await repository.listImagesForProduct(productId, businessId);
  await repository.applyImageOrder(
    productId,
    businessId,
    remaining.map((row) => row.id),
  );
}

/**
 * Reorders a product's photos.
 *
 * The submitted list must be exactly the product's images — same ids, same
 * count. A partial list is refused instead of being applied to the prefix,
 * because the obvious way to get one is a stale dashboard tab: applying it
 * would silently renumber photos the user could not see and cannot have meant
 * to move.
 */
export async function reorderImages(
  productId: string,
  businessId: string,
  imageIds: string[],
): Promise<ProductImageView[]> {
  await requireProduct(productId, businessId);

  const current = await repository.listImagesForProduct(productId, businessId);
  const currentIds = new Set(current.map((row) => row.id));
  const submitted = new Set(imageIds);

  if (
    submitted.size !== imageIds.length ||
    submitted.size !== currentIds.size ||
    imageIds.some((id) => !currentIds.has(id))
  ) {
    throw new ValidationError(
      'The photo order sent does not match this product. Reload the page and try again.',
    );
  }

  await repository.applyImageOrder(productId, businessId, imageIds);
  const reordered = await repository.listImagesForProduct(productId, businessId);
  return reordered.map(toView);
}

/**
 * Reads a photo's bytes back out of the bucket for the dashboard.
 *
 * Served through the API rather than from a bucket URL for the same reason the
 * payment screenshots are: the bucket is private, and the tenant check then
 * happens on every single view instead of resting on an object key being hard
 * to guess.
 */
export async function readImageFile(
  productId: string,
  imageId: string,
  businessId: string,
): Promise<ArchivedMedia> {
  const image = await repository.findImageById(imageId, businessId);
  if (!image || image.productId !== productId) {
    throw new NotFoundError('That photo is not on this product');
  }

  const media = await getArchivedMedia(image.key);
  if (!media) {
    throw new NotFoundError('That photo could not be read from storage');
  }

  return media;
}

/** Attaches each product's photos to a list of products in one extra query. */
export async function attachImages<T extends { id: string }>(
  products: T[],
  businessId: string,
): Promise<Array<T & { images: ProductImageView[] }>> {
  const grouped = await repository.listImagesForProducts(
    products.map((product) => product.id),
    businessId,
  );

  return products.map((product) => ({
    ...product,
    images: (grouped.get(product.id) ?? []).map(toView),
  }));
}

async function requireProduct(productId: string, businessId: string): Promise<void> {
  const product = await productRepository.findProductById(productId, businessId);
  if (!product) throw new NotFoundError('Product not found');
}

/**
 * Where a product photo lives in the bucket.
 *
 * A fresh UUID per upload rather than a name derived from the product: the same
 * product can hold six photos and can have one replaced, and a derived key
 * would make a replacement overwrite bytes that a message already in flight is
 * still about to send. Nothing from the client reaches the key, so a filename
 * cannot steer the object out of the tenant's own prefix.
 */
function imageKey(businessId: string, productId: string, mimeType: string): string {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
  return `businesses/${businessId}/products/${productId}/${randomUUID()}.${extension}`;
}
