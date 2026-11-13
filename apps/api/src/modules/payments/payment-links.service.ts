import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  commissionPercentFor,
  initializeHostedCharge,
} from '../../services/billing/paystack-connect.js';
import {
  deliverText,
  loadNotificationContext,
} from '../../services/notifications/customer-notifications.js';
import * as repository from './payment-links.repository.js';
import { lockPaymentRelationship, requirePaymentActor } from './payment-relationships.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { explicitPaymentRequest } from '../../services/assistant/commitment.js';

/**
 * Payment links: asking a customer for money, and recognising it when it lands.
 *
 * The flow this replaces asked the customer to send money to a momo number
 * printed in a chat message and then to photograph the confirmation. That has
 * three failures a shop feels every week — the customer types the number wrong,
 * the screenshot is of someone else's payment, and the owner has to read and
 * believe every one of them. A hosted link removes all three: Paystack takes
 * the money, tells us it settled, and the reference is checkable afterwards by
 * anyone.
 *
 * Screenshots still work. Plenty of customers will pay the shop's momo number
 * directly whatever the link says, and a shop midway through payout setup has
 * to be able to take money today. What changed is which one is the default.
 */

/**
 * How long a link stays open.
 *
 * Long enough to survive a customer who goes to find their phone, short enough
 * that an abandoned link does not resurface a week later at a price the shop
 * has since changed. Paystack itself does not expire a reference, so this is
 * Flowdesk's own promise about what the link means.
 */
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Paystack's minimum charge in Ghana is GHS 1. Below that the API refuses and
 * the owner gets a gateway error instead of a sentence they can act on.
 */
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 1_000_000;

export interface PaymentLinkView {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  url: string;
  status: string;
  orderId: string | null;
  customerId: string;
  channel: string | null;
  paidAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function toView(row: repository.PaymentRequestRow): PaymentLinkView {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    reference: row.reference,
    url: row.authorizationUrl,
    status: row.status,
    orderId: row.orderId,
    customerId: row.customerId,
    channel: row.channel,
    paidAt: row.paidAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * A reference that is unguessable and recognisably ours.
 *
 * The prefix lets the shared Paystack webhook tell a customer payment from a
 * subscription charge before it touches the database. The random half is what
 * makes it safe: a reference is the only thing correlating a webhook to a row,
 * so a sequential one would let anyone who received one link enumerate every
 * other shop's payments.
 */
function newReference(): string {
  return `fdpay-${randomBytes(12).toString('hex')}`;
}

export function isPaymentLinkReference(reference: string | null | undefined): boolean {
  return typeof reference === 'string' && reference.startsWith('fdpay-');
}

interface PayoutReadyBusiness {
  id: string;
  name: string;
  email: string | null;
  paystackSubaccountCode: string;
  commissionPercent: number | null;
}

/**
 * The business, provided it can actually be paid.
 *
 * Refused rather than defaulted when payouts are not set up. A link created
 * without a subaccount would settle into Flowdesk's own balance — the shop
 * would be owed money by us, which is exactly the arrangement this design
 * exists to avoid.
 */
async function requirePayoutReady(businessId: string, tx: Prisma.TransactionClient): Promise<PayoutReadyBusiness> {
  if (!features.billing) {
    throw new ValidationError('Card and mobile money payments are not configured on this deployment.');
  }

  const business = await tx.business.findFirst({
    where: { id: businessId, deletedAt: null, active: true },
    select: {
      id: true,
      name: true,
      email: true,
      paystackSubaccountCode: true,
      commissionPercent: true,
    },
  });

  if (!business) throw new NotFoundError('Business not found');

  if (!business.paystackSubaccountCode) {
    throw new ValidationError(
      'Add the momo number or bank account you want to be paid into before sending a payment link. Settings → Payouts.',
    );
  }

  return {
    id: business.id,
    name: business.name,
    email: business.email,
    paystackSubaccountCode: business.paystackSubaccountCode,
    commissionPercent:
      business.commissionPercent === null ? null : Number(business.commissionPercent),
  };
}

export interface CreateLinkInput {
  customerId: string;
  orderId?: string | null | undefined;
  amount: number;
  /** Send the link to the customer on WhatsApp straight away. */
  send?: boolean | undefined;
  /** Overrides the default sentence that carries the link. */
  message?: string | null | undefined;
  assistantCheckout?: { messageId?: string };
}

async function verifyAssistantCheckout(tx: Prisma.TransactionClient, businessId: string, input: CreateLinkInput): Promise<void> {
  if (!input.assistantCheckout) return;
  const { customerId, orderId, assistantCheckout } = input;
  await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR SHARE`;
  const [order, business, message, ledger] = await Promise.all([
    tx.order.findFirst({ where: { id: orderId ?? '', businessId, customerId, deletedAt: null,
      customer: { blacklisted: false }, status: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'FULFILLED'] } },
      select: { totalAmount: true, deliveryCapturedAt: true } }),
    tx.business.findFirst({ where: { id: businessId, active: true, deletedAt: null, deactivatedAt: null,
      aiAssistMode: 'AUTONOMOUS', autonomyAcceptedAt: { not: null } }, select: { id: true } }),
    assistantCheckout.messageId ? tx.message.findFirst({ where: { id: assistantCheckout.messageId, businessId, customerId,
      direction: 'INBOUND' }, select: { body: true } }) : null,
    tx.payment.findMany({ where: { orderId: orderId ?? '', businessId, customerId, voidedAt: null,
      confidence: { not: 'CLAIMED' } }, select: { amount: true, direction: true } }),
  ]);
  const requested = assistantCheckout.messageId ? Boolean(message?.body && explicitPaymentRequest(message.body)) : Boolean(order?.deliveryCapturedAt);
  const due = order && ledger.reduce((balance, payment) => payment.direction === 'IN' ? balance.minus(payment.amount) : balance.plus(payment.amount), order.totalAmount);
  if (!business || !due || !requested || !due.eq(input.amount)) {
    throw new ConflictError('Assistant checkout no longer matches the outstanding order');
  }
}

/**
 * Raises a payment link, and optionally sends it.
 *
 * An open link for the same order and amount is reused rather than replaced. A
 * shop that taps "request payment" twice should not put two live URLs for one
 * debt in front of a customer; that is how the same order gets paid twice and
 * then has to be refunded by hand.
 */
export async function createPaymentLink(
  businessId: string,
  input: CreateLinkInput,
  staffId: string | null | undefined,
): Promise<PaymentLinkView> {
  if (!Number.isFinite(input.amount) || input.amount < MIN_AMOUNT) {
    throw new ValidationError(`A payment link has to be for at least GHS ${MIN_AMOUNT}.`);
  }
  if (input.amount > MAX_AMOUNT) {
    throw new ValidationError('That amount is too large for a single payment link.');
  }

  const amountMinor = Math.round(input.amount * 100);
  const normalized = { ...input, amount: amountMinor / 100 };
  const prepared = await prisma.$transaction(async (tx) => {
    await requirePaymentActor(tx, businessId, staffId ?? null, 'payments.create');
    await lockPaymentRelationship(tx, { ...input, businessId });
    await verifyAssistantCheckout(tx, businessId, normalized);
    const business = await requirePayoutReady(businessId, tx);
    if (input.orderId) {
      const existing = await repository.findOpenRequestForOrder(
        businessId, input.orderId, normalized.amount, input.customerId, tx,
      );
      if (existing) return { kind: 'existing' as const, row: existing };
    }
    const scope = { businessId, customerId: input.customerId, orderId: input.orderId ?? null, amountMinor };
    const unresolved = await tx.paystackInitialization.findFirst({
      where: { ...scope, state: { in: ['INITIALIZING', 'REVIEW'] } },
      orderBy: { createdAt: 'asc' },
    });
    if (unresolved) return { kind: 'waiting' as const, reference: unresolved.reference };

    const intent = await tx.paystackInitialization.create({
      data: {
        ...scope, reference: newReference(), subaccountCode: business.paystackSubaccountCode,
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      },
    });
    return { kind: 'new' as const, intent };
  });

  let row: repository.PaymentRequestRow;
  if (prepared.kind === 'existing') row = prepared.row;
  else if (prepared.kind === 'waiting') row = await waitForInitialization(businessId, prepared.reference);
  else {
    const { intent } = prepared;
    try {
      row = await prisma.$transaction(async (tx) => {
        await requirePaymentActor(tx, businessId, staffId ?? null, 'payments.create');
        await lockPaymentRelationship(tx, { ...normalized, businessId });
        await verifyAssistantCheckout(tx, businessId, normalized);
        await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR SHARE`;
        const business = await requirePayoutReady(businessId, tx);
        if (business.paystackSubaccountCode !== intent.subaccountCode) {
          throw new ConflictError('Payout destination changed during checkout initialization');
        }
        const [owned] = await tx.$queryRaw<Array<{ reference: string }>>`
          SELECT reference FROM paystack_initializations WHERE reference = ${intent.reference}
            AND "businessId" = ${businessId} AND state = 'INITIALIZING' FOR UPDATE
        `;
        if (!owned) throw new ConflictError('Checkout initialization is no longer eligible');
        const created = await initializePaymentRequest(tx, business, normalized, staffId ?? null, intent.reference, intent.expiresAt);
        await tx.paystackInitialization.update({
          where: { reference: intent.reference, businessId, state: 'INITIALIZING' },
          data: { state: 'CREATED', requestId: created.id },
        });
        if (staffId !== undefined) {
          await logActivity({
            staffId, businessId, action: 'payment.link_created', resourceId: created.id, resourceType: 'payment_request',
          }, tx);
        }
        return created;
      }, { timeout: 15_000 });
    } catch (error: unknown) {
      await prisma.paystackInitialization.updateMany({
        where: { reference: intent.reference, businessId, state: 'INITIALIZING' },
        data: { state: 'REVIEW', reason: 'INITIALIZATION_UNCONFIRMED' },
      }).catch(() => logger.warn({ reference: intent.reference }, 'Paystack initialization remains unresolved'));
      throw error;
    }
  }

  if (input.send) await sendLinkToCustomer(businessId, row, input.message ?? null, input.assistantCheckout);
  return toView(row);
}

async function waitForInitialization(businessId: string, reference: string): Promise<repository.PaymentRequestRow> {
  const deadline = Date.now() + 12_000;
  do {
    const intent = await prisma.paystackInitialization.findUnique({ where: { reference, businessId } });
    if (intent?.state === 'CREATED' && intent.requestId) {
      const row = await repository.findById(intent.requestId, businessId);
      if (row?.status === 'PENDING' && row.expiresAt > new Date()) return row;
    }
    if (intent?.state !== 'INITIALIZING' || Date.now() - intent.createdAt.getTime() > 60_000) {
      throw new ConflictError('An earlier checkout requires reconciliation');
    }
    await delay(150);
  } while (Date.now() < deadline);
  throw new ConflictError('An earlier checkout is still being initialized');
}

async function initializePaymentRequest(
  tx: Prisma.TransactionClient,
  business: PayoutReadyBusiness,
  input: CreateLinkInput,
  staffId: string | null,
  reference: string,
  expiresAt: Date,
): Promise<repository.PaymentRequestRow> {
  const businessId = business.id;
  const commission = commissionPercentFor(business.commissionPercent);

  const charge = await initializeHostedCharge({
    // Paystack requires an email. A customer messaging on WhatsApp has not
    // given one and should not be asked for one to pay, so a per-shop
    // non-routable address stands in — it is only ever used as Paystack's
    // customer key and no mail is sent to it.
    email: business.email ?? `payments+${business.id}@flowdesk.invalid`,
    // Pesewas. Rounded rather than truncated: a half-pesewa lost per charge is
    // small and a half-pesewa short is a charge Paystack will not reconcile.
    amountMinor: Math.round(input.amount * 100),
    reference,
    subaccountCode: business.paystackSubaccountCode,
    ...(env.PAYSTACK_CALLBACK_URL ? { callbackUrl: env.PAYSTACK_CALLBACK_URL } : {}),
    metadata: {
      flowdeskBusinessId: businessId,
      flowdeskCustomerId: input.customerId,
      ...(input.orderId ? { flowdeskOrderId: input.orderId } : {}),
      custom_fields: [
        { display_name: 'Shop', variable_name: 'shop', value: business.name },
      ],
    },
  });

  const row = await repository.createPaymentRequest({
    businessId,
    customerId: input.customerId,
    orderId: input.orderId ?? null,
    amount: input.amount,
    reference,
    authorizationUrl: charge.authorizationUrl,
    accessCode: charge.accessCode,
    subaccountCode: business.paystackSubaccountCode,
    // Recorded as cedis at today's rate, not recomputed later from whatever the
    // commission happens to be when someone opens a report.
    platformFee: Math.round(input.amount * commission) / 100,
    expiresAt,
    createdByStaffId: staffId,
  }, tx);

  logger.info(
    { businessId, reference, amount: input.amount, orderId: input.orderId ?? null },
    'Payment link created',
  );

  return row;
}

/**
 * Sends the link on WhatsApp.
 *
 * Routed through `deliverText` like every other customer message, so it
 * inherits the 24-hour window check, the blacklist and the owner-takeover gate.
 * A payment request that talks over an owner mid-negotiation is worse than one
 * that waits.
 */
async function sendLinkToCustomer(
  businessId: string,
  row: repository.PaymentRequestRow,
  message: string | null,
  assistantCheckout?: CreateLinkInput['assistantCheckout'],
): Promise<void> {
  const context = await loadNotificationContext(businessId, row.customerId);
  if (!context) {
    if (assistantCheckout) throw new ConflictError('Assistant checkout awaits notification');
    return;
  }

  const amount = Number(row.amount).toFixed(2);
  const text =
    message?.trim() ||
    `Here's your payment link for GHS ${amount}. You can pay with MTN MoMo, Telecel Cash, AirtelTigo Money or a card:\n${row.authorizationUrl}`;

  const sent = await deliverText(context, text, {
    humanInitiated: true,
    ...(assistantCheckout ? {
      idempotencyKey: `assistant-checkout-${assistantCheckout.messageId ?? row.id}`,
      requireQueueHandoff: true,
    } : {}),
    // One send per request per call. Repeating a reminder is a legitimate thing
    // for an owner to do, so the key is not the request id alone — see the note
    // on `EnqueueOptions.idempotencyKey`.
  });
  if (assistantCheckout && !sent.allowed) throw new ConflictError('Assistant checkout awaits notification');
}

export async function listPaymentLinks(
  businessId: string,
  filters: {
    status?: repository.PaymentRequestRow['status'] | undefined;
    customerId?: string | undefined;
    orderId?: string | undefined;
    limit?: number | undefined;
  },
): Promise<PaymentLinkView[]> {
  const rows = await repository.listPaymentRequests(businessId, {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.orderId ? { orderId: filters.orderId } : {}),
    limit: Math.min(filters.limit ?? 50, 200),
  });

  return rows.map(toView);
}

/** Withdraws a link the owner no longer wants honoured. */
export async function cancelPaymentLink(id: string, businessId: string, staffId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await requirePaymentActor(tx, businessId, staffId, 'payments.create');
    const existing = await repository.findById(id, businessId, tx);
    if (!existing) throw new NotFoundError('Payment link not found');
    await lockPaymentRelationship(tx, existing, true);
    if (!(await repository.cancelRequest(existing, tx))) {
      throw new ValidationError(
        existing.status === 'PAID'
          ? 'That link has already been paid, so it cannot be cancelled. Void the payment instead.'
          : 'That link is no longer open.',
      );
    }
    await logActivity({ staffId, businessId, action: 'payment.link_cancelled', resourceId: id, resourceType: 'payment_request' }, tx);
  });
}

/**
 * Which rail the money came in on.
 *
 * Paystack reports `channel` as the broad method and, for mobile money, the
 * network in `authorization.bank`. Both are consulted so the shop's ledger says
 * "MTN MoMo" rather than the useless "mobile money" — an owner reconciling
 * against their own momo statement needs to know which wallet to open.
 */
export function methodFromCharge(channel: string | null, bank: string | null): PaymentMethod {
  if (channel === 'card') return 'CARD';
  if (channel === 'bank' || channel === 'bank_transfer') return 'BANK_TRANSFER';

  if (channel === 'mobile_money') {
    const network = (bank ?? '').toLowerCase();
    if (network.includes('mtn')) return 'MOMO_MTN';
    // Telecel bought Vodafone Ghana in 2023. Paystack has returned both names
    // during the transition, and rows written under either have to land in the
    // same bucket or a shop's history splits in two.
    if (network.includes('telecel') || network.includes('vodafone')) return 'MOMO_VODAFONE';
    if (network.includes('airtel') || network.includes('tigo')) return 'MOMO_AIRTELTIGO';
    return 'OTHER';
  }

  return 'OTHER';
}

/** Closes links nobody paid. Run from a schedule; safe to run at any time. */
export async function expireStaleLinks(): Promise<number> {
  const expired = await repository.expireStaleRequests();
  if (expired > 0) logger.info({ expired }, 'Closed expired payment links');
  return expired;
}
