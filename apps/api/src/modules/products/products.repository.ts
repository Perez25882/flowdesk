import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { CreateProductInput, UpdateProductInput, StockAdjustmentInput, ListProductsQueryInput } from './products.schema.js';

export interface ProductWithStock {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  price: Prisma.Decimal;
  stockQuantity: Prisma.Decimal;
  reorderThreshold: Prisma.Decimal;
  aliases: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Pricing, as numbers rather than `Decimal`.
   *
   * Deliberately different from `price` above, which reaches the browser as a
   * string because `Prisma.Decimal.toJSON()` returns one and always has. That
   * is long-standing behaviour the web has been built around; changing it here
   * would be a silent, untestable edit to every screen that shows a price. New
   * fields start correct instead, and the inconsistency is written down rather
   * than spread.
   */
  floorPrice?: number | null;
  discountPercent?: number | null;
  discountLabel?: string | null;
  discountEndsAt?: Date | null;
  tiers?: Array<{ minQuantity: number; percentOff: number }>;
}

/** Adds the pricing fields to a raw row, converting the one Decimal among them. */
function withPricing(
  row: { floorPrice: Prisma.Decimal | null; quantityTiers?: Array<{ minQuantity: number; percentOff: number }> } & Record<string, unknown>,
): ProductWithStock {
  const { quantityTiers, ...rest } = row;
  return {
    ...(rest as unknown as ProductWithStock),
    floorPrice: row.floorPrice === null ? null : Number(row.floorPrice),
    tiers: quantityTiers ?? [],
  };
}

export async function createProduct(
  data: CreateProductInput,
  businessId: string,
): Promise<ProductWithStock> {
  const product = await prisma.product.create({
    data: {
      businessId,
      name: data.name,
      sku: data.sku ?? null,
      unit: data.unit,
      price: new Prisma.Decimal(data.price),
      stockQuantity: new Prisma.Decimal(data.stockQuantity ?? 0),
      reorderThreshold: new Prisma.Decimal(data.reorderThreshold ?? 0),
      aliases: data.aliases ?? [],
      floorPrice: data.floorPrice === null || data.floorPrice === undefined
        ? null
        : new Prisma.Decimal(data.floorPrice),
      discountPercent: data.discountPercent ?? null,
      discountLabel: data.discountLabel ?? null,
      discountEndsAt: data.discountEndsAt ?? null,
      ...(data.tiers && data.tiers.length > 0
        ? { quantityTiers: { createMany: { data: data.tiers } } }
        : {}),
    },
  });
  return product as ProductWithStock;
}

/** Active product count, used for plan-limit checks. */
export async function countProducts(businessId: string): Promise<number> {
  return prisma.product.count({ where: { businessId, deletedAt: null } });
}

export async function findProductById(id: string, businessId: string): Promise<ProductWithStock | null> {
  const product = await prisma.product.findFirst({
    where: { id, businessId, deletedAt: null },
    include: { quantityTiers: { orderBy: { minQuantity: 'asc' } } },
  });
  return product === null ? null : withPricing(product);
}

export async function listProducts(
  businessId: string,
  filters: ListProductsQueryInput,
): Promise<ProductWithStock[]> {
  const where: Prisma.ProductWhereInput = { businessId, deletedAt: null };
  if (filters.active !== undefined) where.active = filters.active;
  if (filters.lowStock) {
    // Same column-to-column rule as getLowStockProducts, resolved to ids first
    // so the rest of the filters still apply through the normal query builder.
    where.id = { in: await lowStockProductIds(businessId) };
  }
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { sku: { contains: filters.search, mode: 'insensitive' } },
      { aliases: { hasSome: [filters.search] } },
    ];
  }

  const products = await prisma.product.findMany({
    where,
    orderBy: { name: 'asc' },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
    include: { quantityTiers: { orderBy: { minQuantity: 'asc' } } },
  });
  return products.map(withPricing);
}

export async function updateProduct(
  id: string,
  businessId: string,
  data: UpdateProductInput,
): Promise<ProductWithStock> {
  const updateData: Prisma.ProductUpdateInput = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.sku !== undefined) updateData.sku = data.sku ?? null;
  if (data.unit !== undefined) updateData.unit = data.unit;
  if (data.price !== undefined) updateData.price = new Prisma.Decimal(data.price);
  if (data.stockQuantity !== undefined) updateData.stockQuantity = new Prisma.Decimal(data.stockQuantity);
  if (data.reorderThreshold !== undefined) updateData.reorderThreshold = new Prisma.Decimal(data.reorderThreshold);
  if (data.aliases !== undefined) updateData.aliases = data.aliases;
  if (data.active !== undefined) updateData.active = data.active;
  // Null is a meaningful value here and `undefined` is not: null clears the
  // floor, undefined leaves it alone. Collapsing the two would mean an owner
  // editing only a product's name silently removed the floor they had set.
  if (data.floorPrice !== undefined) {
    updateData.floorPrice = data.floorPrice === null ? null : new Prisma.Decimal(data.floorPrice);
  }
  if (data.discountPercent !== undefined) updateData.discountPercent = data.discountPercent;
  if (data.discountLabel !== undefined) updateData.discountLabel = data.discountLabel;
  if (data.discountEndsAt !== undefined) updateData.discountEndsAt = data.discountEndsAt;

  // Tiers are replaced wholesale rather than merged: the form sends the list it
  // wants to end up with, and a merge would make a removed tier impossible to
  // express. Done in one transaction so a failure between the delete and the
  // create cannot leave a product with no bulk pricing the owner still sees on
  // their screen.
  const product = await prisma.$transaction(async (tx) => {
    if (data.tiers !== undefined) {
      await tx.quantityTier.deleteMany({ where: { productId: id } });
      if (data.tiers.length > 0) {
        await tx.quantityTier.createMany({
          data: data.tiers.map((tier) => ({ ...tier, productId: id })),
        });
      }
    }

    return tx.product.update({ where: { id, businessId }, data: updateData });
  });

  return product as ProductWithStock;
}

export async function deleteProduct(id: string, businessId: string): Promise<void> {
  await prisma.product.update({
    where: { id, businessId },
    data: { deletedAt: new Date() },
  });
}

export async function adjustStock(
  id: string,
  businessId: string,
  data: StockAdjustmentInput,
  staffId: string | null,
): Promise<ProductWithStock> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findFirst({
      where: { id, businessId },
      select: { stockQuantity: true },
    });
    if (!current) throw new Error('Product not found');

    // RESTOCK is validated positive; ADJUSTMENT carries a signed delta. Both
    // are therefore applied by addition — a downward correction arrives as a
    // negative quantity.
    const newQuantity = new Prisma.Decimal(current.stockQuantity.toString()).add(
      new Prisma.Decimal(data.quantity),
    );

    const product = await tx.product.update({
      where: { id, businessId },
      data: { stockQuantity: newQuantity },
    });

    await tx.stockMovement.create({
      data: {
        businessId,
        productId: id,
        type: data.type,
        quantity: new Prisma.Decimal(data.quantity),
        balanceAfter: newQuantity,
        staffId: staffId ?? null,
        note: data.note ?? null,
      },
    });

    return product as ProductWithStock;
  });
}

export async function findActiveCatalogProducts(
  businessId: string,
): Promise<Array<{ id: string; name: string; aliases: string[]; unit: string; price: number }>> {
  const products = await prisma.product.findMany({
    where: {
      businessId,
      active: true,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      aliases: true,
      unit: true,
      price: true,
    },
  });

  return products.map((p) => ({
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    unit: p.unit,
    price: Number(p.price),
  }));
}

/** A catalog row as the assistant sees it: everything needed to answer, nothing more. */
export interface CatalogProductWithStock {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  price: number;
  stockQuantity: number;
  /**
   * The first photo, or null when the shop has uploaded none.
   *
   * Fetched with the catalogue rather than on demand because the assistant
   * needs it at the moment it decides what to say: "do you have it in black"
   * is answered very differently by a shop that can show the thing. One
   * `include` costs one join; looking it up afterwards would cost a round trip
   * inside the reply path, which is the one place latency is visible to a
   * customer.
   */
  photoId: string | null;
  /**
   * What the assistant is allowed to charge, and the lowest it may agree to.
   *
   * Fetched with the catalogue for the same reason the photo is: the decision
   * about what a thing costs is made at the moment of the reply, and a price
   * looked up afterwards is a price that could have changed between the model
   * being told one number and the server enforcing another.
   */
  floorPrice: number | null;
  discountPercent: number | null;
  discountLabel: string | null;
  discountEndsAt: Date | null;
  tiers: Array<{ minQuantity: number; percentOff: number }>;
}

/**
 * The active catalog including stock levels.
 *
 * Separate from `findActiveCatalogProducts` because that one feeds keyword
 * scoring, which has no use for stock. Answering a customer does: "do you have
 * malta?" is a stock question, and without the quantity the assistant can only
 * confirm the product exists — which is how a shop promises something it cannot
 * deliver.
 *
 * `price` and `stockQuantity` are Prisma `Decimal`s; they are converted here so
 * callers never serialize `{"s":1,"e":1,"d":[50]}` into a prompt.
 */
export async function findCatalogProductsWithStock(
  businessId: string,
): Promise<CatalogProductWithStock[]> {
  const products = await prisma.product.findMany({
    where: {
      businessId,
      active: true,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      aliases: true,
      unit: true,
      price: true,
      stockQuantity: true,
      floorPrice: true,
      discountPercent: true,
      discountLabel: true,
      discountEndsAt: true,
      images: {
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        take: 1,
        select: { id: true },
      },
      quantityTiers: {
        orderBy: { minQuantity: 'asc' },
        select: { minQuantity: true, percentOff: true },
      },
    },
  });

  return products.map((p) => ({
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    unit: p.unit,
    price: Number(p.price),
    stockQuantity: Number(p.stockQuantity),
    photoId: p.images[0]?.id ?? null,
    floorPrice: p.floorPrice === null ? null : Number(p.floorPrice),
    discountPercent: p.discountPercent,
    discountLabel: p.discountLabel,
    discountEndsAt: p.discountEndsAt,
    tiers: p.quantityTiers,
  }));
}

export interface StockDeductionAlert {
  productId: string;
  productName: string;
  currentStock: number;
  threshold: number;
}

export async function deductStockForOrderItems(
  orderId: string,
  businessId: string,
  /** Staff id, or null when the owner confirmed it. `StockMovement.staffId` is nullable. */
  confirmedBy: string | null,
  items: Array<{ productId: string | null; quantity: number | Prisma.Decimal; matched: boolean }>,
  tx?: Prisma.TransactionClient,
): Promise<StockDeductionAlert[]> {
  const db = tx ?? prisma;
  const alerts: StockDeductionAlert[] = [];

  for (const item of items) {
    if (!item.productId || !item.matched) continue;

    const product = await db.product.findFirst({
      where: { id: item.productId, businessId },
      select: { id: true, stockQuantity: true, name: true, reorderThreshold: true },
    });

    if (!product) continue;

    const newQty = new Prisma.Decimal(product.stockQuantity.toString()).sub(
      new Prisma.Decimal(item.quantity.toString()),
    );

    await db.product.update({
      where: { id: product.id },
      data: { stockQuantity: newQty },
    });

    await db.stockMovement.create({
      data: {
        businessId,
        productId: product.id,
        type: 'SALE',
        quantity: new Prisma.Decimal(item.quantity.toString()).neg(),
        balanceAfter: newQty,
        orderId,
        staffId: confirmedBy,
      },
    });

    const threshold = Number(product.reorderThreshold);
    if (threshold > 0 && Number(newQty) <= threshold) {
      alerts.push({
        productId: product.id,
        productName: product.name,
        currentStock: Number(newQty),
        threshold,
      });
    }
  }

  return alerts;
}

/**
 * Products at or below their reorder threshold.
 *
 * "Low stock" is a comparison between two columns, which Prisma's filter API
 * cannot express — the previous implementation approximated it as
 * `stockQuantity <= 0` and therefore never warned the owner until stock had
 * already run out. Raw SQL is used so the real condition is evaluated.
 */
export async function getLowStockProducts(businessId: string): Promise<ProductWithStock[]> {
  return prisma.$queryRaw<ProductWithStock[]>`
    SELECT *
    FROM "products"
    WHERE "businessId" = ${businessId}
      AND "deletedAt" IS NULL
      AND "active" = true
      AND "reorderThreshold" > 0
      AND "stockQuantity" <= "reorderThreshold"
    ORDER BY ("stockQuantity" - "reorderThreshold") ASC
  `;
}

/** Ids of low-stock products, used to apply the same rule inside a filtered list. */
async function lowStockProductIds(businessId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "products"
    WHERE "businessId" = ${businessId}
      AND "deletedAt" IS NULL
      AND "reorderThreshold" > 0
      AND "stockQuantity" <= "reorderThreshold"
  `;

  return rows.map((row) => row.id);
}

/**
 * Puts stock back after an order that had already taken it out is cancelled.
 *
 * The mirror of `deductStockForOrderItems`, and deliberately written as its own
 * function rather than a sign flag on that one: the movement type differs
 * (RETURN, so the stock ledger says why the quantity came back), and there are
 * no reorder alerts to raise — stock going up cannot cross a threshold
 * downwards.
 *
 * Only ever called after `claimStockMovement` has won the right to run it, so
 * a double cancellation cannot credit the same items twice.
 */
export async function restoreStockForOrderItems(
  orderId: string,
  businessId: string,
  /** Staff id, or null when the owner cancelled it. */
  cancelledBy: string | null,
  items: Array<{ productId: string | null; quantity: number | Prisma.Decimal; matched: boolean }>,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;

  for (const item of items) {
    if (!item.productId || !item.matched) continue;

    const product = await db.product.findFirst({
      where: { id: item.productId, businessId },
      select: { id: true, stockQuantity: true },
    });

    if (!product) continue;

    const quantity = new Prisma.Decimal(item.quantity.toString());
    const newQty = new Prisma.Decimal(product.stockQuantity.toString()).add(quantity);

    await db.product.update({
      where: { id: product.id },
      data: { stockQuantity: newQty },
    });

    await db.stockMovement.create({
      data: {
        businessId,
        productId: product.id,
        type: 'RETURN',
        quantity,
        balanceAfter: newQty,
        orderId,
        staffId: cancelledBy,
        note: 'Order cancelled',
      },
    });
  }
}
