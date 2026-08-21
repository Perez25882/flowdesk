import { prisma } from '../../config/database.js';
import { Prisma } from '@prisma/client';
import type { PaymentConfidence, PaymentDirection } from '@flowdesk/shared';
import type { CreatePaymentInput, ListPaymentsQueryInput } from './payments.schema.js';
import { recalculateCustomerTotals } from '../customers/customers.repository.js';
import type { ConfirmPaymentInput } from './payments.schema.js';

/**
 * What counts as money, as a Prisma filter.
 *
 * The database-side twin of `isAttested` in @flowdesk/shared. The two must agree;
 * if you change one, change the other.
 */
export const ATTESTED_PAYMENT = {
  confidence: { not: 'CLAIMED' },
  voidedAt: null,
} satisfies Prisma.PaymentWhereInput;

export interface PaymentWithCustomer {
  id: string;
  amount: Prisma.Decimal;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  attestedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  screenshotUrl: string | null;
  /** The archive key of the screenshot this claim came from, if any. */
  screenshotKey: string | null;
  customer: { id: string; name: string | null; waNumber: string };
  orderId: string | null;
  order?: { id: string; referenceNumber: string; amountPaid: Prisma.Decimal; totalAmount: Prisma.Decimal } | null;
  createdAt: Date;
}

export async function createPayment(
  data: CreatePaymentInput,
  businessId: string,
  loggedById: string | null,
): Promise<PaymentWithCustomer> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        businessId,
        customerId: data.customerId,
        orderId: data.orderId ?? null,
        amount: new Prisma.Decimal(data.amount),
        method: data.method,
        direction: data.direction,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        loggedById,
        confidence: data.attested ? 'SELLER_ATTESTED' : 'CLAIMED',
        // The owner has no staff row, so `loggedById` is null when the owner
        // logs their own attested payment — the dominant write path. Falling
        // back to 'owner' here matches the attest/void routes
        // (`request.user?.staffId ?? 'owner'`) so tier-1 attestations always
        // name an attester instead of silently recording NULL for the actor
        // whose word the tier is supposed to rest on.
        attestedBy: data.attested ? (loggedById ?? 'owner') : null,
        attestedAt: data.attested ? new Date() : null,
      },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    // Only attested money moves totals, so they are refreshed only then.
    if (data.attested) {
      if (payment.orderId) {
        await recalculateOrderPaid(payment.orderId, tx);
      }
      await recalculateCustomerTotals(payment.customerId, tx);
    }

    return payment as unknown as PaymentWithCustomer;
  });
}

export async function findPaymentById(id: string, businessId: string): Promise<PaymentWithCustomer | null> {
  const payment = await prisma.payment.findFirst({
    where: { id, businessId },
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payment as PaymentWithCustomer | null;
}

export async function listPayments(
  businessId: string,
  filters: ListPaymentsQueryInput,
): Promise<PaymentWithCustomer[]> {
  const where: Prisma.PaymentWhereInput = { businessId };
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.orderId) where.orderId = filters.orderId;
  if (filters.confidence) where.confidence = filters.confidence;
  // `attested` narrows by voidedAt always, and by confidence only when the
  // caller did not already supply an explicit `confidence` filter — an
  // unconditional Object.assign here used to silently overwrite a caller's
  // `confidence` filter with the `attested` bucket's own, so e.g.
  // `?confidence=GATEWAY_CONFIRMED&attested=false` returned CLAIMED rows
  // instead of an empty (or, at the service layer, rejected) result. The
  // service layer above rejects genuinely contradictory combinations before
  // this runs, so an explicit `confidence` reaching here is always
  // compatible with `attested` and is left alone to do the narrowing.
  if (filters.attested === true) {
    where.voidedAt = null;
    if (!filters.confidence) where.confidence = ATTESTED_PAYMENT.confidence;
  }
  // A live claim awaiting the owner's confirmation — deliberately excludes voided
  // rows. A voided payment is already resolved and needs no action, so it belongs
  // in neither the "attested" nor the "needs checking" bucket. It stays reachable
  // by listing without the `attested` filter.
  if (filters.attested === false) {
    where.voidedAt = null;
    if (!filters.confidence) where.confidence = 'CLAIMED';
  }
  // Keyed on the archive key, not the URL. The key is written for every
  // screenshot claim the moment it is recorded; the URL only appears once the
  // image has actually reached the bucket, which it never does when media
  // storage is unconfigured. Filtering on the URL — as this used to — hid every
  // screenshot claim on a deployment without S3, which is all of them today.
  if (filters.hasScreenshot) {
    where.screenshotKey = { not: null };
  }
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(filters.dateFrom);
    if (filters.dateTo) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(filters.dateTo);
  }

  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
  return payments as PaymentWithCustomer[];
}

/**
 * Recomputes an order's `amountPaid` from its attested payments, net of refunds.
 *
 * Materialised rather than accumulated, so attesting, voiding or refunding always
 * lands on the correct figure instead of drifting.
 *
 * The two aggregates run in sequence, not in parallel: an interactive Prisma
 * transaction holds a single connection and concurrent queries on it are not safe.
 */
async function recalculateOrderPaid(
  orderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const received = await tx.payment.aggregate({
    where: { orderId, direction: 'IN', ...ATTESTED_PAYMENT },
    _sum: { amount: true },
  });
  const refunded = await tx.payment.aggregate({
    where: { orderId, direction: 'OUT', ...ATTESTED_PAYMENT },
    _sum: { amount: true },
  });

  const net = (received._sum.amount ?? new Prisma.Decimal(0))
    .sub(refunded._sum.amount ?? new Prisma.Decimal(0));

  await tx.order.update({ where: { id: orderId }, data: { amountPaid: net } });
}

/**
 * Records the seller's attestation that the money landed.
 *
 * The update is conditional on the payment still being an unvoided claim, so two
 * simultaneous attestations resolve to exactly one. Returns null when the claim
 * had already been taken — the caller reports that as a conflict, not an error.
 */
export async function attestPaymentWithSideEffects(
  paymentId: string,
  businessId: string,
  attestedBy: string,
): Promise<PaymentWithCustomer | null> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, businessId, confidence: 'CLAIMED', voidedAt: null },
      data: { confidence: 'SELLER_ATTESTED', attestedBy, attestedAt: new Date() },
    });

    if (claimed.count !== 1) return null;

    const updated = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    if (updated.orderId) {
      await recalculateOrderPaid(updated.orderId, tx);
    }
    await recalculateCustomerTotals(updated.customerId, tx);

    return updated as unknown as PaymentWithCustomer;
  });
}

/**
 * Reverses a payment's effect without destroying the record of it.
 *
 * This used to be a hard DELETE. A deleted payment is a destroyed alibi: the one
 * artefact a dispute turns on is what was claimed, by whom, and when. Voiding
 * keeps the row, the reason and the actor, and repairs every total it fed.
 *
 * Returns false when the payment does not exist or was already voided, so a
 * double-submit is a no-op rather than a second reversal.
 */
export async function voidPayment(
  id: string,
  businessId: string,
  voidedBy: string,
  reason: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id, businessId, voidedAt: null },
      data: { voidedAt: new Date(), voidedBy, voidReason: reason },
    });

    if (claimed.count !== 1) return false;

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id },
      select: { customerId: true, orderId: true },
    });

    if (payment.orderId) {
      await recalculateOrderPaid(payment.orderId, tx);
    }
    await recalculateCustomerTotals(payment.customerId, tx);

    return true;
  });
}

export async function getRevenueStats(businessId: string): Promise<{
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  async function netFrom(since: Date | null): Promise<number> {
    const window = since ? { createdAt: { gte: since } } : {};
    const received = await prisma.payment.aggregate({
      where: { businessId, direction: 'IN', ...ATTESTED_PAYMENT, ...window },
      _sum: { amount: true },
    });
    const refunded = await prisma.payment.aggregate({
      where: { businessId, direction: 'OUT', ...ATTESTED_PAYMENT, ...window },
      _sum: { amount: true },
    });
    return Number(received._sum.amount ?? 0) - Number(refunded._sum.amount ?? 0);
  }

  const [totalRevenue, today, thisWeek, thisMonth, byMethodAgg] = await Promise.all([
    netFrom(null),
    netFrom(startOfDay),
    netFrom(startOfWeek),
    netFrom(startOfMonth),
    // Money in, by method. Refunds are excluded rather than netted: the question
    // this answers is which rails customers actually pay on.
    prisma.payment.groupBy({
      by: ['method'],
      where: { businessId, direction: 'IN', ...ATTESTED_PAYMENT },
      _sum: { amount: true },
    }),
  ]);

  const byMethod: Record<string, number> = {};
  for (const row of byMethodAgg) {
    byMethod[row.method] = Number(row._sum.amount ?? 0);
  }

  return { totalRevenue, today, thisWeek, thisMonth, byMethod };
}


/**
 * One thing waiting for the owner's judgement.
 *
 * Every unvoided CLAIMED payment qualifies, whichever way it got there: a
 * screenshot the detector flagged, or an amount counter staff wrote down and
 * cannot attest to themselves. Both are the same question — did this money
 * actually arrive — and answering it is the same tap.
 */
export interface ReviewQueueItem {
  paymentId: string;
  kind: 'SCREENSHOT' | 'LOGGED';
  /** Null when nobody has read the amount off the screenshot yet. */
  amount: number | null;
  method: string;
  direction: PaymentDirection;
  confidence: PaymentConfidence;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
  customer: { id: string; name: string | null; waNumber: string };
  order: {
    id: string;
    referenceNumber: string;
    totalAmount: number;
    amountPaid: number;
    outstanding: number;
  } | null;
  screenshot: {
    /** False when the image could not be archived. The claim still stands. */
    available: boolean;
    /** Path to fetch the image bytes from, relative to the API base. */
    viewUrl: string | null;
    unavailableReason: 'NOT_ARCHIVED' | null;
    caption: string | null;
    receivedAt: Date | null;
    messageId: string | null;
  } | null;
}

/**
 * Everything the owner has to check, newest first.
 *
 * Decimals are converted to numbers here rather than handed out raw: a Prisma
 * Decimal serialises as its own internal shape, and a dashboard reading
 * `amount` off it gets an object where it expected money.
 */
export async function listReviewQueue(
  businessId: string,
  limit: number,
): Promise<ReviewQueueItem[]> {
  const claims = await prisma.payment.findMany({
    where: { businessId, confidence: 'CLAIMED', voidedAt: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      customer: { select: { id: true, name: true, waNumber: true } },
      order: {
        select: { id: true, referenceNumber: true, totalAmount: true, amountPaid: true },
      },
    },
  });

  // The message the screenshot arrived on carries the caption and the time the
  // customer sent it — the context that makes a bare image interpretable. It is
  // fetched in one query for the whole page rather than one per row.
  const screenshotKeys = claims
    .map((claim) => claim.screenshotKey)
    .filter((key): key is string => key !== null);

  const messages =
    screenshotKeys.length > 0
      ? await prisma.message.findMany({
          where: { businessId, mediaKey: { in: screenshotKeys } },
          select: { id: true, mediaKey: true, body: true, createdAt: true },
        })
      : [];

  const messageByKey = new Map(messages.map((message) => [message.mediaKey, message]));

  return claims.map((claim) => {
    const message = claim.screenshotKey ? messageByKey.get(claim.screenshotKey) : undefined;
    const amount = Number(claim.amount);

    return {
      paymentId: claim.id,
      kind: claim.screenshotKey ? 'SCREENSHOT' : 'LOGGED',
      amount: amount === 0 ? null : amount,
      method: claim.method,
      direction: claim.direction as PaymentDirection,
      confidence: claim.confidence as PaymentConfidence,
      reference: claim.reference,
      notes: claim.notes,
      createdAt: claim.createdAt,
      customer: claim.customer,
      order: claim.order
        ? {
            id: claim.order.id,
            referenceNumber: claim.order.referenceNumber,
            totalAmount: Number(claim.order.totalAmount),
            amountPaid: Number(claim.order.amountPaid),
            outstanding: Number(claim.order.totalAmount) - Number(claim.order.amountPaid),
          }
        : null,
      screenshot: claim.screenshotKey
        ? {
            available: claim.screenshotUrl !== null,
            viewUrl: claim.screenshotUrl !== null ? `/payments/${claim.id}/screenshot` : null,
            unavailableReason: claim.screenshotUrl === null ? 'NOT_ARCHIVED' : null,
            caption: message?.body ?? null,
            receivedAt: message?.createdAt ?? null,
            messageId: message?.id ?? null,
          }
        : null,
    };
  });
}

/** The archive key of a payment's screenshot, for serving the image back. */
export async function findScreenshotKey(
  paymentId: string,
  businessId: string,
): Promise<{ key: string; archived: boolean } | null> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, businessId },
    select: { screenshotKey: true, screenshotUrl: true },
  });

  if (!payment?.screenshotKey) return null;

  return { key: payment.screenshotKey, archived: payment.screenshotUrl !== null };
}

/**
 * Fills in what the owner read off the screenshot and attests it in one write.
 *
 * Same conditional `updateMany` as `attestPaymentWithSideEffects`, for the same
 * reason: the row moves out of CLAIMED exactly once, so a double-tap on a slow
 * connection confirms one payment rather than two. The amount and method are set
 * in the same statement as the confidence, so there is no window in which an
 * attested payment carries the placeholder figures.
 *
 * Returns null when the claim had already been taken or voided.
 */
export async function confirmClaimWithSideEffects(
  paymentId: string,
  businessId: string,
  data: ConfirmPaymentInput,
  attestedBy: string,
): Promise<PaymentWithCustomer | null> {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.payment.findFirst({
      where: { id: paymentId, businessId },
      select: { orderId: true },
    });

    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, businessId, confidence: 'CLAIMED', voidedAt: null },
      data: {
        amount: new Prisma.Decimal(data.amount),
        method: data.method,
        confidence: 'SELLER_ATTESTED',
        attestedBy,
        attestedAt: new Date(),
        ...(data.orderId !== undefined ? { orderId: data.orderId } : {}),
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
      },
    });

    if (claimed.count !== 1) return null;

    const updated = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        customer: { select: { id: true, name: true, waNumber: true } },
        order: { select: { id: true, referenceNumber: true, amountPaid: true, totalAmount: true } },
      },
    });

    // A claim can be attached to an order at the moment it is confirmed, so the
    // order it left has to be recomputed too — otherwise the old order keeps
    // credit for money that has just been moved onto a different one.
    if (previous?.orderId && previous.orderId !== updated.orderId) {
      await recalculateOrderPaid(previous.orderId, tx);
    }
    if (updated.orderId) {
      await recalculateOrderPaid(updated.orderId, tx);
    }
    await recalculateCustomerTotals(updated.customerId, tx);

    return updated as unknown as PaymentWithCustomer;
  });
}
