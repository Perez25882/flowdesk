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
  });
  return product as ProductWithStock | null;
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
  });
  return products as ProductWithStock[];
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

  const product = await prisma.product.update({
    where: { id, businessId },
    data: updateData,
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
    },
  });

  return products.map((p) => ({
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    unit: p.unit,
    price: Number(p.price),
    stockQuantity: Number(p.stockQuantity),
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
