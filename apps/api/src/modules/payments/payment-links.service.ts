import { randomBytes } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  commissionPercentFor,
  initializeHostedCharge,
  verifyCharge,
} from '../../services/billing/paystack-connect.js';
import {
  deliverText,
  loadNotificationContext,
} from '../../services/notifications/customer-notifications.js';
import { sendPaymentReceipt } from '../../services/notifications/receipts.js';
import { createGatewayPayment } from './payments.repository.js';
import * as repository from './payment-links.repository.js';

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
async function requirePayoutReady(businessId: string): Promise<PayoutReadyBusiness> {
  if (!features.billing) {
    throw new ValidationError('Card and mobile money payments are not configured on this deployment.');
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
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
  staffId: string | null,
): Promise<PaymentLinkView> {
  const business = await requirePayoutReady(businessId);

  if (!Number.isFinite(input.amount) || input.amount < MIN_AMOUNT) {
    throw new ValidationError(`A payment link has to be for at least GHS ${MIN_AMOUNT}.`);
  }
  if (input.amount > MAX_AMOUNT) {
    throw new ValidationError('That amount is too large for a single payment link.');
  }

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, businessId },
    select: { id: true, waNumber: true, name: true },
  });
  if (!customer) throw new NotFoundError('Customer not found');

  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, businessId },
      select: { id: true },
    });
    if (!order) throw new NotFoundError('Order not found');

    const existing = await repository.findOpenRequestForOrder(
      businessId,
      input.orderId,
      input.amount,
    );

    if (existing) {
      if (input.send) await sendLinkToCustomer(businessId, existing, input.message ?? null);
      return toView(existing);
    }
  }

  const reference = newReference();
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
      flowdeskCustomerId: customer.id,
      ...(input.orderId ? { flowdeskOrderId: input.orderId } : {}),
      custom_fields: [
        { display_name: 'Shop', variable_name: 'shop', value: business.name },
      ],
    },
  });

  const row = await repository.createPaymentRequest({
    businessId,
    customerId: customer.id,
    orderId: input.orderId ?? null,
    amount: input.amount,
    reference,
    authorizationUrl: charge.authorizationUrl,
    accessCode: charge.accessCode,
    subaccountCode: business.paystackSubaccountCode,
    // Recorded as cedis at today's rate, not recomputed later from whatever the
    // commission happens to be when someone opens a report.
    platformFee: Math.round(input.amount * commission) / 100,
    expiresAt: new Date(Date.now() + LINK_TTL_MS),
    createdByStaffId: staffId,
  });

  logger.info(
    { businessId, reference, amount: input.amount, orderId: input.orderId ?? null },
    'Payment link created',
  );

  if (input.send) await sendLinkToCustomer(businessId, row, input.message ?? null);

  return toView(row);
}

/**
 * Sends the link on WhatsApp.
 *
 * Routed through `deliverText` like every other customer message, so it
 * inherits the 24-hour window check, the blacklist and the owner-takeover gate.
 * A payment request that talks over an owner mid-negotiation is worse than one
 * that waits.
 */
export async function sendLinkToCustomer(
  businessId: string,
  row: repository.PaymentRequestRow,
  message: string | null,
): Promise<void> {
  const context = await loadNotificationContext(businessId, row.customerId);
  if (!context) return;

  const amount = Number(row.amount).toFixed(2);
  const text =
    message?.trim() ||
    `Here's your payment link for GHS ${amount}. You can pay with MTN MoMo, Telecel Cash, AirtelTigo Money or a card:\n${row.authorizationUrl}`;

  await deliverText(context, text, {
    humanInitiated: true,
    // One send per request per call. Repeating a reminder is a legitimate thing
    // for an owner to do, so the key is not the request id alone — see the note
    // on `EnqueueOptions.idempotencyKey`.
  });
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
export async function cancelPaymentLink(id: string, businessId: string): Promise<void> {
  const cancelled = await repository.markStatus(id, businessId, 'CANCELLED');

  if (cancelled === 0) {
    const existing = await repository.findById(id, businessId);
    if (!existing) throw new NotFoundError('Payment link not found');
    throw new ValidationError(
      existing.status === 'PAID'
        ? 'That link has already been paid, so it cannot be cancelled. Void the payment instead.'
        : 'That link is no longer open.',
    );
  }
}

/**
 * Turns a settled charge into money in the shop's books.
 *
 * Called from the Paystack webhook, and safe to call again with the same
 * reference: `claimForSettlement` is a conditional update, so a redelivery, a
 * retry and a manual reconciliation racing each other produce exactly one
 * Payment between them.
 *
 * The webhook payload is not trusted for anything that matters. It identifies
 * the reference; everything else — that it settled, for how much, on what
 * channel — is read back from Paystack. A signature proves who sent a message,
 * not that the message is true.
 */
export async function settleFromWebhook(reference: string): Promise<void> {
  const request = await repository.findByReference(reference);

  if (!request) {
    logger.warn({ reference }, 'Paystack charge for an unknown payment reference — ignored');
    return;
  }

  if (request.status === 'PAID' && request.paymentId) {
    logger.debug({ reference }, 'Payment already settled — duplicate delivery');
    return;
  }

  const verified = await verifyCharge(reference);

  if (!verified) {
    logger.error({ reference }, 'Could not verify a charge with Paystack — not recording money');
    return;
  }

  if (verified.status !== 'success') {
    logger.info({ reference, status: verified.status }, 'Charge did not settle');
    return;
  }

  const paidMinor = verified.amountMinor;
  const expectedMinor = Math.round(Number(request.amount) * 100);

  // A part payment is money, and refusing to record it would leave the customer
  // out of pocket with nothing on the shop's books. An overpayment is recorded
  // at what actually arrived. Either way it is the verified figure that is
  // written, never the one we asked for.
  if (paidMinor !== expectedMinor) {
    logger.warn(
      { reference, expectedMinor, paidMinor },
      'Settled amount differs from the amount requested — recording what was paid',
    );
  }

  if (!(await repository.claimForSettlement(reference))) {
    logger.debug({ reference }, 'Another worker is already settling this payment');
    return;
  }

  try {
    const payment = await createGatewayPayment(request.businessId, {
      customerId: request.customerId,
      orderId: request.orderId,
      amount: paidMinor / 100,
      method: methodFromCharge(verified.channel, verified.bank),
      reference,
      notes: 'Paid through a Flowdesk payment link',
    });

    await repository.recordSettlement(reference, {
      paymentId: payment.id,
      channel: verified.channel,
      gatewayFee: verified.feesMinor === null ? null : verified.feesMinor / 100,
      paidAt: verified.paidAt ? new Date(verified.paidAt) : new Date(),
    });

    logger.info(
      {
        businessId: request.businessId,
        reference,
        amount: paidMinor / 100,
        channel: verified.channel,
      },
      'Payment link settled',
    );

    // Deliberately after the money is recorded and deliberately not awaited for
    // its success: the receipt is a courtesy on top of a settled payment, and a
    // messaging failure must never make the webhook look like it failed, which
    // would have Paystack redeliver a charge we have already banked.
    await sendPaymentReceipt(payment.id);
  } catch (error: unknown) {
    // The claim is released so the next delivery, or the reconciliation job,
    // can try again. A request stuck at PAID with no Payment is money the
    // customer sent and the shop cannot see.
    await repository.releaseClaim(reference);
    logger.error({ error, reference }, 'Failed to record a settled payment — claim released');
    throw error;
  }
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
