import { Prisma } from '@prisma/client';
import { ConflictError } from '../../utils/errors.js';

export async function lockCommerceProducts(
  tx: Prisma.TransactionClient, businessId: string, ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const products = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM products WHERE "businessId" = ${businessId} AND id IN (${Prisma.join(ids)})
    ORDER BY id FOR UPDATE
  `;
  if (products.length !== new Set(ids).size) throw new ConflictError('A selected product is unavailable');
}

export async function heldStock(
  tx: Prisma.TransactionClient, businessId: string, productId: string, now: Date,
): Promise<Prisma.Decimal> {
  const [result] = await tx.$queryRaw<{ held: Prisma.Decimal }[]>`
    SELECT COALESCE(SUM(l.quantity), 0)::decimal AS held
    FROM commerce_quote_lines l
    JOIN commerce_quotes q ON q.id = l."quoteId" AND q."businessId" = l."businessId"
    WHERE l."businessId" = ${businessId} AND l."productId" = ${productId}
      AND q.state = 'OFFERED' AND q."expiresAt" > ${now}
  `;
  return result!.held;
}

export async function requireUnreservedStock(
  tx: Prisma.TransactionClient, businessId: string, productId: string, remainder: Prisma.Decimal,
): Promise<void> {
  const policy = await tx.commercePolicy.findUnique({ where: { businessId }, select: { enabled: true } });
  const held = await heldStock(tx, businessId, productId, new Date());
  if ((policy?.enabled || held.gt(0)) && remainder.lt(held)) throw new ConflictError('Insufficient unreserved stock');
}
