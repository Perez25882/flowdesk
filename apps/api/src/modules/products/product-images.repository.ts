import { prisma } from '../../config/database.js';
import type { Prisma } from '@prisma/client';

export interface ProductImageRow {
  id: string;
  productId: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  position: number;
  createdAt: Date;
}

const ROW_SELECT = {
  id: true,
  productId: true,
  key: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  position: true,
  createdAt: true,
} satisfies Prisma.ProductImageSelect;

export async function listImagesForProduct(
  productId: string,
  businessId: string,
): Promise<ProductImageRow[]> {
  return prisma.productImage.findMany({
    where: { productId, businessId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: ROW_SELECT,
  });
}

/**
 * Every image belonging to a set of products, grouped by product.
 *
 * One query for the whole catalogue page rather than one per row: a shop with
 * two hundred products and four photos each would otherwise open two hundred
 * round trips to render a list of thumbnails.
 */
export async function listImagesForProducts(
  productIds: string[],
  businessId: string,
): Promise<Map<string, ProductImageRow[]>> {
  const grouped = new Map<string, ProductImageRow[]>();
  if (productIds.length === 0) return grouped;

  const rows = await prisma.productImage.findMany({
    where: { productId: { in: productIds }, businessId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: ROW_SELECT,
  });

  for (const row of rows) {
    const existing = grouped.get(row.productId);
    if (existing) existing.push(row);
    else grouped.set(row.productId, [row]);
  }

  return grouped;
}

export async function countImagesForProduct(productId: string, businessId: string): Promise<number> {
  return prisma.productImage.count({ where: { productId, businessId } });
}

export async function findImageById(
  id: string,
  businessId: string,
): Promise<(ProductImageRow & { businessId: string }) | null> {
  return prisma.productImage.findFirst({
    where: { id, businessId },
    select: { ...ROW_SELECT, businessId: true },
  });
}

export async function createImage(data: {
  businessId: string;
  productId: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  position: number;
}): Promise<ProductImageRow> {
  return prisma.productImage.create({ data, select: ROW_SELECT });
}

export async function deleteImage(id: string, businessId: string): Promise<void> {
  await prisma.productImage.deleteMany({ where: { id, businessId } });
}

/**
 * Applies an order the owner dragged into place.
 *
 * Written as one transaction of positional updates scoped by `businessId`, so
 * an id belonging to another tenant that was slipped into the list simply
 * matches nothing instead of being reordered. The caller has already checked
 * that the set of ids is exactly the product's own images, which is what stops
 * a partial list from leaving holes in the ordering.
 */
export async function applyImageOrder(
  productId: string,
  businessId: string,
  orderedIds: string[],
): Promise<void> {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.productImage.updateMany({
        where: { id, productId, businessId },
        data: { position: index },
      }),
    ),
  );
}

/** The next free slot at the end of a product's strip. */
export async function nextPosition(productId: string, businessId: string): Promise<number> {
  const last = await prisma.productImage.findFirst({
    where: { productId, businessId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return last ? last.position + 1 : 0;
}

/**
 * The first photo of each product that has one.
 *
 * Feeds the assistant: it needs to know *whether* a product has a picture to
 * offer one, and which one to send, but never the rest of the strip.
 */
export async function findPrimaryImages(
  businessId: string,
  productIds: string[],
): Promise<Map<string, ProductImageRow>> {
  const primary = new Map<string, ProductImageRow>();
  if (productIds.length === 0) return primary;

  const rows = await prisma.productImage.findMany({
    where: { productId: { in: productIds }, businessId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: ROW_SELECT,
  });

  for (const row of rows) {
    if (!primary.has(row.productId)) primary.set(row.productId, row);
  }

  return primary;
}

/** The cached Meta media id for an image, if one was uploaded from this number. */
export async function findCachedMetaMedia(
  imageId: string,
): Promise<{ waMediaId: string; waMediaPhoneNumberId: string; waMediaUploadedAt: Date } | null> {
  const row = await prisma.productImage.findUnique({
    where: { id: imageId },
    select: { waMediaId: true, waMediaPhoneNumberId: true, waMediaUploadedAt: true },
  });

  if (!row?.waMediaId || !row.waMediaPhoneNumberId || !row.waMediaUploadedAt) return null;

  return {
    waMediaId: row.waMediaId,
    waMediaPhoneNumberId: row.waMediaPhoneNumberId,
    waMediaUploadedAt: row.waMediaUploadedAt,
  };
}

export async function recordMetaMedia(
  imageId: string,
  waMediaId: string,
  phoneNumberId: string,
): Promise<void> {
  await prisma.productImage.updateMany({
    where: { id: imageId },
    data: { waMediaId, waMediaPhoneNumberId: phoneNumberId, waMediaUploadedAt: new Date() },
  });
}

/**
 * Forgets a cached media id Meta no longer recognises.
 *
 * Conditional on the id still being the one we just failed with, so a
 * concurrent re-upload that already refreshed the cache is not wiped by a
 * straggling failure from the old one.
 */
export async function clearMetaMedia(imageId: string, staleMediaId: string): Promise<void> {
  await prisma.productImage.updateMany({
    where: { id: imageId, waMediaId: staleMediaId },
    data: { waMediaId: null, waMediaPhoneNumberId: null, waMediaUploadedAt: null },
  });
}
