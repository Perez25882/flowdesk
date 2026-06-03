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
    where.stockQuantity = { lte: new Prisma.Decimal(0) };
    where.reorderThreshold = { gt: new Prisma.Decimal(0) };
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

    const newQuantity = data.type === 'RESTOCK'
      ? new Prisma.Decimal(current.stockQuantity.toString()).add(new Prisma.Decimal(data.quantity))
      : new Prisma.Decimal(current.stockQuantity.toString()).add(new Prisma.Decimal(data.quantity));

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

export interface StockDeductionAlert {
  productId: string;
  productName: string;
  currentStock: number;
  threshold: number;
}

export async function deductStockForOrderItems(
  orderId: string,
  businessId: string,
  confirmedBy: string,
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

export async function getLowStockProducts(businessId: string): Promise<ProductWithStock[]> {
  const products = await prisma.product.findMany({
    where: {
      businessId,
      deletedAt: null,
      active: true,
      stockQuantity: { lte: new Prisma.Decimal(0) },
      reorderThreshold: { gt: new Prisma.Decimal(0) },
    },
    orderBy: { stockQuantity: 'asc' },
  });
  return products as ProductWithStock[];
}
