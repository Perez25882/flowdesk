import { createHash } from 'node:crypto';
import { Prisma, type CommercePolicy, type CommerceQuote, type CommerceQuoteLine } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { lockCustomerForTotals, recalculateCustomerTotals } from '../customers/customers.repository.js';
import { createOrder, updateOrderStatus } from '../orders/orders.repository.js';
import { deductStockForOrderItems } from '../products/products.repository.js';
import { lockCommerceProducts, heldStock } from './commerce.stock.js';
import type { QuoteInput } from './commerce.contract.js';

type Tx = Prisma.TransactionClient;
type Scope = { businessId: string; customerId: string };
type Quote = CommerceQuote & { lines: CommerceQuoteLine[] };

export async function activeCommercePolicy(tx: Tx, businessId: string): Promise<CommercePolicy> {
  const [policy] = await tx.$queryRaw<CommercePolicy[]>`
    SELECT * FROM commerce_policies WHERE "businessId" = ${businessId} AND enabled FOR SHARE
  `;
  if (!policy) throw new ConflictError('Commerce workflows are unavailable for this business');
  return policy;
}

export async function loadCommerceSource(tx: Tx, scope: Scope, id: string): Promise<{
  id: string; body: string | null; createdAt: Date; waMessageId: string;
}> {
  const [owned] = await tx.$queryRaw<{ id: string }[]>`
    SELECT m.id FROM messages m
    JOIN whatsapp_text_receipts r ON r."messageId" = m.id AND r."businessId" = m."businessId"
    JOIN businesses b ON b.id = m."businessId" AND b."waPhoneNumberId" = r."phoneNumberId"
    JOIN whatsapp_phone_ownership o ON o.id = r."ownershipId" AND o."businessId" = b.id
      AND o."phoneNumberId" = r."phoneNumberId" AND o."endedAt" IS NULL
    WHERE m.id = ${id} AND m."businessId" = ${scope.businessId} AND m."customerId" = ${scope.customerId}
      AND b.active AND b."deletedAt" IS NULL AND b."deactivatedAt" IS NULL AND b."suspendedAt" IS NULL
    FOR SHARE OF b, o
  `;
  if (!owned) throw new NotFoundError('Authenticated customer message not found');
  const source = await tx.message.findFirst({
    where: { id, businessId: scope.businessId, customerId: scope.customerId, direction: 'INBOUND', type: 'TEXT',
      customer: { businessId: scope.businessId, deletedAt: null, blacklisted: false },
      textReceipt: { businessId: scope.businessId, kind: 'TEXT', status: 'COMPLETED' } },
    select: { id: true, body: true, createdAt: true, waMessageId: true },
  });
  if (!source) throw new NotFoundError('Authenticated customer message not found');
  return source;
}

function price(product: {
  price: Prisma.Decimal; floorPrice: Prisma.Decimal | null; discountPercent: number | null; discountEndsAt: Date | null;
  quantityTiers: { minQuantity: number; percentOff: number }[];
}, quantity: number, now: Date): Prisma.Decimal {
  const promo = !product.discountEndsAt || +product.discountEndsAt > +now ? product.discountPercent ?? 0 : 0;
  const tier = product.quantityTiers.find((entry) => entry.minQuantity <= quantity)?.percentOff ?? 0;
  if (product.floorPrice?.gt(product.price) || [promo, tier].some((discount) => discount < 0 || discount >= 100)) {
    throw new ConflictError('The catalogue pricing policy requires review');
  }
  return Prisma.Decimal.max(product.floorPrice ?? 0, product.price.mul(100 - Math.max(promo, tier)).div(100).toDecimalPlaces(2));
}

async function quoteLines(
  tx: Tx, scope: Scope, input: { productId: string; quantity: number }[], now: Date, ownOffer?: Quote,
) {
  const ids = input.map((item) => item.productId);
  const ancestry = await tx.product.findMany({ where: { businessId: scope.businessId, id: { in: ids } }, select: { variantOfId: true } });
  const locks = [...new Set([...ids, ...ancestry.flatMap((product) => product.variantOfId ? [product.variantOfId] : [])])];
  await lockCommerceProducts(tx, scope.businessId, locks);
  const products = await tx.product.findMany({
    where: { businessId: scope.businessId, id: { in: ids }, active: true, deletedAt: null,
      OR: [{ variantOfId: null }, { variantOf: { businessId: scope.businessId, active: true, deletedAt: null } }] },
    include: { quantityTiers: { orderBy: { minQuantity: 'desc' } } },
  });
  if (products.length !== ids.length) throw new ConflictError('A selected product is unavailable');
  return Promise.all(input.map(async ({ productId, quantity }) => {
    const product = products.find((row) => row.id === productId)!;
    if (product.commerceMode === 'TRACKED') {
      const held = await heldStock(tx, scope.businessId, productId, now);
      const own = ownOffer?.state === 'OFFERED' ? quantity : 0;
      if (product.stockQuantity.minus(held).plus(own).lt(quantity)) throw new ConflictError('Insufficient unreserved stock');
    }
    const unitPrice = price(product, quantity, now);
    if (!unitPrice.gt(0)) throw new ConflictError('A selected item has no payable price');
    return { productId, quantity, sku: product.sku, itemName: product.variantLabel
      ? product.name + ' · ' + product.variantLabel : product.name,
    productMode: product.commerceMode, listPrice: product.price, unitPrice };
  }));
}

function sameTerms(saved: Quote, current: Awaited<ReturnType<typeof quoteLines>>): void {
  if (current.some((line) => {
    const old = saved.lines.find((savedLine) => savedLine.productId === line.productId);
    return !old || !old.unitPrice.eq(line.unitPrice) || !old.listPrice.eq(line.listPrice) ||
      old.productMode !== line.productMode || old.sku !== line.sku || old.itemName !== line.itemName;
  })) throw new ConflictError('The catalogue terms changed. Request a new quote.');
}

async function lockQuote(tx: Tx, businessId: string, id: string): Promise<Quote> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM commerce_quotes WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE
  `;
  if (!locked) throw new NotFoundError('Quote not found');
  return tx.commerceQuote.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { productId: 'asc' } } } });
}

export async function createCommerceQuote(tx: Tx, businessId: string, input: QuoteInput, now = new Date()): Promise<Quote> {
  const { customerId, requestKey, items } = input;
  const scope = { businessId, customerId };
  const normalized = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
  const requestHash = createHash('sha256').update(JSON.stringify({ ...input, items: normalized })).digest('hex');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'commerce-quote:' + businessId + ':' + requestKey}, 0))`;
  const prior = await tx.commerceQuote.findUnique({ where: { businessId_requestKey: { businessId, requestKey } }, include: { lines: true } });
  if (prior) {
    if (prior.requestHash !== requestHash) throw new ConflictError('Quote request key already has different terms');
    return prior;
  }
  const policy = await activeCommercePolicy(tx, businessId);
  const customer = await lockCustomerForTotals(tx, customerId, businessId);
  if (!customer || customer.deletedAt || !await tx.customer.findFirst({ where: { id: customerId, businessId, blacklisted: false }, select: { id: true } })) {
    throw new NotFoundError('Customer not found');
  }
  if (input.sourceId) await loadCommerceSource(tx, scope, input.sourceId);
  if (input.deliveryMode === 'PICKUP' ? !policy.allowPickup : !policy.allowDelivery) throw new ConflictError('This fulfillment mode is unavailable');
  const lines = await quoteLines(tx, scope, normalized, now);
  const custom = lines.some((line) => line.productMode === 'MADE_TO_ORDER');
  if (custom && !input.specification) throw new ValidationError('Enter the made-to-order specification');
  const total = lines.reduce((sum, line) => sum.plus(line.unitPrice.mul(line.quantity)), new Prisma.Decimal(0));
  if (total.gt('9999999999.99')) throw new ValidationError('Quote total is too large');
  return tx.commerceQuote.create({ data: {
    ...scope, requestKey, requestHash, policyRevision: policy.revision, total,
    state: custom ? 'DRAFT' : 'OFFERED', deliveryMode: input.deliveryMode, address: input.address ?? null,
    specification: input.specification ?? null, sourceId: input.sourceId ?? null,
    expiresAt: new Date(+now + policy.quoteMinutes * 60_000), issuedAt: custom ? null : now,
    lines: { create: lines },
  }, include: { lines: { orderBy: { productId: 'asc' } } } });
}

export async function decideCommerceQuote(tx: Tx, businessId: string, id: string, offer: boolean, now = new Date()): Promise<Quote> {
  const quote = await lockQuote(tx, businessId, id);
  if (quote.state === (offer ? 'OFFERED' : 'DECLINED')) return quote;
  if (+quote.expiresAt <= +now || !(offer ? quote.state === 'DRAFT' : ['DRAFT', 'OFFERED'].includes(quote.state))) {
    throw new ConflictError('This quote no longer accepts a decision');
  }
  if (offer) {
    const policy = await activeCommercePolicy(tx, businessId);
    if (quote.policyRevision !== policy.revision) throw new ConflictError('Business policy changed. Request a new quote.');
    sameTerms(quote, await quoteLines(tx, quote, quote.lines, now));
  }
  return tx.commerceQuote.update({ where: { id }, data: { state: offer ? 'OFFERED' : 'DECLINED',
    ...(offer ? { issuedAt: now } : {}) }, include: { lines: true } });
}

export async function acceptCommerceQuote(tx: Tx, scope: Scope, id: string, sourceId: string, now = new Date()): Promise<Quote> {
  const customer = await lockCustomerForTotals(tx, scope.customerId, scope.businessId);
  if (!customer || customer.deletedAt) throw new NotFoundError('Customer not found');
  const quote = await lockQuote(tx, scope.businessId, id);
  if (quote.customerId !== scope.customerId) throw new NotFoundError('Quote not found');
  const source = await loadCommerceSource(tx, scope, sourceId);
  if (source.body?.trim().toUpperCase() !== ('ACCEPT ' + id).toUpperCase() || (quote.issuedAt && +source.createdAt < +quote.issuedAt - 1000)) {
    throw new ConflictError('The source does not accept this quote');
  }
  if (quote.state === 'ACCEPTED') return quote;
  const policy = await activeCommercePolicy(tx, scope.businessId);
  if (quote.state !== 'OFFERED' || +quote.expiresAt <= +now || quote.policyRevision !== policy.revision) {
    throw new ConflictError('This quote is expired or no longer available');
  }
  sameTerms(quote, await quoteLines(tx, scope, quote.lines, now, quote));
  await tx.commerceQuote.update({ where: { id }, data: { state: 'ACCEPTED', acceptanceMessageId: sourceId, acceptedAt: now } });
  const referenceNumber = 'FD-Q' + id.replace(/-/g, '').toUpperCase();
  const order = await createOrder({ ...scope, referenceNumber, rawMessage: source.body, isManual: false, inboundSourceMessageId: sourceId,
    items: quote.lines.map((line) => ({ productId: line.productId, description: line.itemName,
      quantity: line.quantity, unitPrice: Number(line.unitPrice), matchConfidence: 1 })),
  }, tx);
  await tx.order.update({ where: { id: order.id }, data: { stockDeducted: true,
    deliveryAddress: quote.address, ...(quote.address ? { deliveryCapturedAt: now } : {}) } });
  await deductStockForOrderItems(order.id, scope.businessId, null, order.items, tx);
  if (!await updateOrderStatus(order.id, scope.businessId, 'CONFIRMED', null, 'Accepted commercial quote', 'PENDING', null, tx)) {
    throw new ConflictError('The order changed before confirmation');
  }
  await tx.message.update({ where: { id: sourceId }, data: { relatedOrderId: order.id } });
  const deposit = quote.total.mul(policy.depositPercent).div(100).toDecimalPlaces(2);
  await tx.commerceInvoice.create({ data: {
    ...scope, orderId: order.id, reference: 'INV-' + referenceNumber.slice(3), total: quote.total,
    deposit, releaseThreshold: policy.releaseOnDeposit && deposit.gt(0) ? deposit : quote.total,
    dueAt: new Date(+now + policy.invoiceDays * 86_400_000),
    receiptLines: quote.lines.map((line) => ({ name: line.itemName, sku: line.sku, quantity: line.quantity,
      listPrice: line.listPrice.toFixed(2), unitPrice: line.unitPrice.toFixed(2), subtotal: line.unitPrice.mul(line.quantity).toFixed(2) })),
  } });
  await recalculateCustomerTotals(scope.customerId, tx);
  return tx.commerceQuote.update({ where: { id }, data: { orderId: order.id }, include: { lines: true } });
}
