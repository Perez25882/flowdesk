import { Prisma, type PaystackReceipt, type PaymentRequest } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { verifyCharge, type VerifiedCharge } from '../../services/billing/paystack-connect.js';
import { isAppError } from '../../utils/errors.js';
import { methodFromCharge } from './payment-links.service.js';
import { lockPaymentRelationship } from './payment-relationships.js';
import { createGatewayPayment } from './payments.repository.js';
import { claimPaystackReceipt, MAX_PAYSTACK_RECEIPT_ATTEMPTS, receiptLease, waitForPaystackRetry } from './paystack-receipts.js';

type SettlementFacts = { transactionId: string; amountMinor: number; paidAt: Date };

function validateCharge(
  receipt: PaystackReceipt, request: PaymentRequest, verified: VerifiedCharge,
): SettlementFacts | string {
  const { transactionId, reference, status, amountMinor, currency, subaccountCode } = verified;
  if (!transactionId || !reference || !status) return 'VERIFICATION_AMBIGUOUS';
  if (reference !== request.reference) return 'REFERENCE_MISMATCH';
  if (receipt.callbackTransactionId !== null && receipt.callbackTransactionId !== transactionId) {
    return 'CALLBACK_TRANSACTION_MISMATCH';
  }
  const mode = env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_') ? 'live' :
    env.PAYSTACK_SECRET_KEY?.startsWith('sk_test_') ? 'test' : null;
  if (!mode || verified.domain !== mode) return 'PROVIDER_MODE_MISMATCH';
  if (status === 'reversed') return 'PROVIDER_REVERSED';
  if (status !== 'success') return 'PROVIDER_NOT_SUCCESSFUL';
  if (!subaccountCode || !request.subaccountCode) return 'MERCHANT_UNPROVEN';
  if (subaccountCode !== request.subaccountCode) return 'MERCHANT_MISMATCH';
  if ((verified.businessId && verified.businessId !== request.businessId) ||
      (verified.customerId && verified.customerId !== request.customerId) ||
      (verified.orderId && verified.orderId !== request.orderId)) return 'VERIFIED_RELATIONSHIP_MISMATCH';
  if (currency !== 'GHS' || currency !== request.currency) return 'CURRENCY_MISMATCH';
  if (amountMinor === null || amountMinor <= 0) return 'AMOUNT_UNPROVEN';
  const expected = request.amount.mul(100);
  if (expected.gt(amountMinor)) return 'PARTIAL_PAYMENT';
  if (expected.lt(amountMinor)) return 'EXCESS_PAYMENT';
  const paidAt = new Date(verified.paidAt ?? '');
  if (!verified.paidAt || !/^\d{4}-\d{2}-\d{2}T/.test(verified.paidAt) || Number.isNaN(paidAt.getTime())) {
    return 'PAYMENT_TIME_UNPROVEN';
  }
  return { transactionId, amountMinor, paidAt };
}

async function finishReceipt(
  tx: Prisma.TransactionClient,
  id: string,
  businessId: string | null,
  state: 'REVIEW' | 'SETTLED',
  reason: string | null,
): Promise<void> {
  await tx.paystackReceipt.update({
    where: { id },
    data: { businessId, state, reason, completedAt: new Date(), leaseToken: null, leaseUntil: null, nextAttemptAt: null },
  });
}

async function applyVerifiedCharge(receipt: PaystackReceipt, verified: VerifiedCharge): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [owned] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM paystack_receipts WHERE id = ${receipt.id} AND state = 'PROCESSING'
        AND "leaseToken" = ${receipt.leaseToken} AND "leaseUntil" > now() FOR UPDATE
    `;
    if (!owned) return;

    const snapshot = await tx.paymentRequest.findUnique({ where: { reference: receipt.reference } });
    if (!snapshot) {
      const init = await tx.paystackInitialization.findUnique({ where: { reference: receipt.reference } });
      const businessId = receipt.businessId ?? init?.businessId ?? null;
      if (init && businessId !== init.businessId) {
        return finishReceipt(tx, receipt.id, businessId, 'REVIEW', 'TENANT_CONFLICT');
      }
      if (init?.state === 'INITIALIZING' && Date.now() - init.createdAt.getTime() < 60_000 &&
          receipt.attempts < MAX_PAYSTACK_RECEIPT_ATTEMPTS) {
        await tx.paystackReceipt.update({
          where: { id: receipt.id },
          data: {
            businessId, state: 'WAITING', reason: 'INITIALIZATION_IN_PROGRESS',
            nextAttemptAt: new Date(Date.now() + 30_000), leaseToken: null, leaseUntil: null,
          },
        });
        return;
      }
      const reason = receipt.requestId ? 'LOCAL_REQUEST_MISSING' : init ? 'INITIALIZATION_UNLINKED' : 'UNKNOWN_REFERENCE';
      await finishReceipt(tx, receipt.id, businessId, 'REVIEW', reason);
      return;
    }
    const businessId = receipt.businessId ?? snapshot.businessId;
    const review = (reason: string) => finishReceipt(tx, receipt.id, businessId, 'REVIEW', reason);
    if (businessId !== snapshot.businessId) return review('TENANT_CONFLICT');
    if (receipt.requestId && receipt.requestId !== snapshot.id) return review('LOCAL_RELATIONSHIP_CHANGED');
    if (!receipt.requestId) {
      await tx.paystackReceipt.update({ where: { id: receipt.id }, data: { requestId: snapshot.id } });
    }

    try {
      await lockPaymentRelationship(tx, snapshot);
    } catch (error: unknown) {
      if (isAppError(error) && (error.statusCode === 400 || error.statusCode === 404)) {
        return review('LOCAL_RELATIONSHIP_INVALID');
      }
      throw error;
    }
    await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${snapshot.id} FOR UPDATE`;
    const request = await tx.paymentRequest.findUnique({ where: { id: snapshot.id } });
    if (!request || request.businessId !== businessId || request.customerId !== snapshot.customerId ||
        request.orderId !== snapshot.orderId || request.reference !== receipt.reference) {
      return review('LOCAL_RELATIONSHIP_CHANGED');
    }

    const facts = validateCharge(receipt, request, verified);
    if (typeof facts === 'string') return review(facts);
    const { transactionId, amountMinor, paidAt } = facts;
    const foreignMerchant = await tx.business.findFirst({
      where: { paystackSubaccountCode: verified.subaccountCode, id: { not: businessId } }, select: { id: true },
    });
    if (foreignMerchant) return review('MERCHANT_MISMATCH');

    // Different references can carry the same transaction ID. Serialize that
    // identity before reading the unique settlement records across requests.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'paystack:' + transactionId}, 0))`;
    const existing = await tx.paystackSettlement.findUnique({ where: { transactionId } });
    if (existing && existing.requestId !== request.id) return review('TRANSACTION_ID_CONFLICT');
    const prior = await tx.paystackSettlement.findUnique({ where: { requestId: request.id } });
    if (prior && prior.transactionId !== transactionId) return review('REQUEST_ALREADY_SETTLED');

    if (request.status === 'PAID' || request.paymentId || prior) {
      if (request.status !== 'PAID' || !request.paymentId || (prior && prior.paymentId !== request.paymentId)) {
        return review('INCOMPLETE_LEGACY_SETTLEMENT');
      }
      const payment = await tx.payment.findUnique({ where: { id: request.paymentId } });
      if (!payment || payment.businessId !== businessId || payment.customerId !== request.customerId ||
          payment.orderId !== request.orderId || payment.reference !== request.reference ||
          payment.direction !== 'IN' || payment.confidence !== 'GATEWAY_CONFIRMED' ||
          !payment.amount.mul(100).eq(amountMinor)) return review('CONFLICTING_LEDGER');
      if (payment.voidedAt) return review('VOIDED_LEDGER');
      const duplicateLedger = await tx.payment.findFirst({
        where: {
          id: { not: payment.id }, reference: request.reference,
          OR: [{ businessId }, { confidence: 'GATEWAY_CONFIRMED' }],
        },
        select: { id: true },
      });
      if (duplicateLedger) return review('CONFLICTING_LEDGER');

      if (!prior) {
        // Preserve the ledger and do not resend an old receipt.
        await tx.paystackSettlement.create({
          data: { transactionId, requestId: request.id, paymentId: payment.id, receiptId: receipt.id, notificationState: 'SUPPRESSED' },
        });
      }
      return finishReceipt(tx, receipt.id, businessId, 'SETTLED', prior ? 'ALREADY_SETTLED' : 'LEGACY_SETTLEMENT_CONFIRMED');
    }

    if (request.status !== 'PENDING' && request.status !== 'EXPIRED') {
      return review(request.status === 'CANCELLED' ? 'REQUEST_CANCELLED' : 'REQUEST_NOT_PAYABLE');
    }
    if (paidAt >= request.expiresAt) return review('LATE_PAYMENT');
    const unlinked = await tx.payment.findFirst({
      where: { reference: request.reference, OR: [{ businessId }, { confidence: 'GATEWAY_CONFIRMED' }] }, select: { id: true },
    });
    if (unlinked) return review('UNLINKED_LEDGER');

    const payment = await createGatewayPayment(tx, businessId, {
      customerId: request.customerId, orderId: request.orderId, amount: amountMinor / 100,
      method: methodFromCharge(verified.channel, verified.bank), reference: request.reference,
      notes: 'Paid through a FlowDesk payment link', paidAt,
    });
    await tx.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: 'PAID', paymentId: payment.id, paidAt, channel: verified.channel,
        gatewayFee: verified.feesMinor === null || verified.feesMinor > amountMinor
          ? null : new Prisma.Decimal(verified.feesMinor).div(100),
      },
    });
    await tx.paystackSettlement.create({
      data: { transactionId, requestId: request.id, paymentId: payment.id, receiptId: receipt.id, notificationNextAt: new Date() },
    });
    await finishReceipt(tx, receipt.id, businessId, 'SETTLED', null);
  });
}

export async function processPaystackReceipt(receipt: PaystackReceipt): Promise<void> {
  if (receipt.state !== 'PROCESSING' || !receipt.leaseToken) return;
  try {
    if (!(await preflightLocalRequest(receipt))) return;
    const verified = await verifyCharge(receipt.reference);
    if (!verified) return await waitForPaystackRetry(receipt, 'VERIFICATION_UNAVAILABLE');
    const saved = await prisma.paystackReceipt.updateMany({
      where: receiptLease(receipt), data: { evidence: { ...verified } },
    });
    if (!saved.count) return;
    if (verified.reference === receipt.reference && verified.transactionId &&
        (receipt.callbackTransactionId === null || receipt.callbackTransactionId === verified.transactionId) &&
        (verified.status === 'pending' || verified.status === 'ongoing' || verified.status === 'processing')) {
      await waitForPaystackRetry(receipt, 'PROVIDER_PENDING');
      return;
    }
    await applyVerifiedCharge(receipt, verified);
  } catch (error: unknown) {
    logger.warn({ receiptId: receipt.id, errorType: error instanceof Error ? error.name : 'Unknown' }, 'Paystack processing will retry');
    await waitForPaystackRetry(receipt, 'LOCAL_WRITE_FAILED');
  }
}

async function preflightLocalRequest(receipt: PaystackReceipt): Promise<boolean> {
  const request = await prisma.paymentRequest.findUnique({ where: { reference: receipt.reference } });
  if (!request) return true;
  let reason: string | undefined;
  if (receipt.businessId && receipt.businessId !== request.businessId) reason = 'TENANT_CONFLICT';
  else if (receipt.requestId && receipt.requestId !== request.id) reason = 'LOCAL_RELATIONSHIP_CHANGED';
  else {
    try {
      await prisma.$transaction((tx) => lockPaymentRelationship(tx, request));
    } catch (error: unknown) {
      if (!isAppError(error) || (error.statusCode !== 400 && error.statusCode !== 404)) throw error;
      reason = 'LOCAL_RELATIONSHIP_INVALID';
    }
  }
  if (!reason) return true;
  await prisma.paystackReceipt.updateMany({
    where: receiptLease(receipt),
    data: {
      businessId: receipt.businessId ?? request.businessId, requestId: receipt.requestId ?? request.id,
      state: 'REVIEW', reason, completedAt: new Date(), leaseToken: null, leaseUntil: null, nextAttemptAt: null,
    },
  });
  return false;
}

export async function drainPaystackReceipts(businessId?: string): Promise<number> {
  let count = 0;
  for (; count < 10; count += 1) {
    const receipt = await claimPaystackReceipt(businessId);
    if (!receipt) break;
    await processPaystackReceipt(receipt);
  }
  return count;
}
