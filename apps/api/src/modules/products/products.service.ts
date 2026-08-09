import { NotFoundError, PlanLimitError } from '../../utils/errors.js';
import { emitStockAlert } from '../../services/sse/sse.events.js';
import { checkProductLimit } from '../../services/plan/plan.service.js';
import type { CreateProductInput, UpdateProductInput, StockAdjustmentInput, ListProductsQueryInput } from './products.schema.js';
import * as repository from './products.repository.js';

export async function createProduct(
  data: CreateProductInput,
  businessId: string,
): Promise<repository.ProductWithStock> {
  const current = await repository.countProducts(businessId);
  const limit = await checkProductLimit(businessId, current);

  if (!limit.allowed) {
    throw new PlanLimitError(
      `Your plan allows ${limit.limit} products. Upgrade to add more.`,
    );
  }

  return repository.createProduct(data, businessId);
}

export async function updateProduct(
  id: string,
  businessId: string,
  data: UpdateProductInput,
): Promise<repository.ProductWithStock> {
  const existing = await repository.findProductById(id, businessId);
  if (!existing) throw new NotFoundError('Product not found');
  return repository.updateProduct(id, businessId, data);
}

export async function deleteProduct(id: string, businessId: string): Promise<void> {
  const existing = await repository.findProductById(id, businessId);
  if (!existing) throw new NotFoundError('Product not found');
  await repository.deleteProduct(id, businessId);
}

export async function findProductById(id: string, businessId: string): Promise<repository.ProductWithStock | null> {
  return repository.findProductById(id, businessId);
}

export async function listProducts(
  businessId: string,
  filters: ListProductsQueryInput,
): Promise<repository.ProductWithStock[]> {
  return repository.listProducts(businessId, filters);
}

export async function adjustStock(
  id: string,
  businessId: string,
  data: StockAdjustmentInput,
  staffId: string | null,
): Promise<repository.ProductWithStock> {
  const existing = await repository.findProductById(id, businessId);
  if (!existing) throw new NotFoundError('Product not found');

  const product = await repository.adjustStock(id, businessId, data, staffId);

  const stockQty = Number(product.stockQuantity);
  const threshold = Number(product.reorderThreshold);
  if (stockQty <= threshold && threshold > 0) {
    emitStockAlert(businessId, {
      productId: product.id,
      productName: product.name,
      currentStock: stockQty,
      threshold,
    });
  }

  return product;
}

export async function getLowStockProducts(businessId: string): Promise<repository.ProductWithStock[]> {
  return repository.getLowStockProducts(businessId);
}
