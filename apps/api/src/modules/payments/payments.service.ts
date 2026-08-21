import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { notifyPaymentReceived } from '../../services/notifications/customer-notifications.js';
import { notifyOwnerPaymentRecorded } from '../../services/notifications/owner-notifications.js';
import { emitPaymentConfirmed } from '../../services/sse/sse.events.js';
import type {
  ConfirmPaymentInput,
  CreatePaymentInput,
  ListPaymentsQueryInput,
  ReviewQueueQueryInput,
} from './payments.schema.js';
import * as repository from './payments.repository.js';
import { clearScreenshotReviewFlag } from './screenshot-claims.js';
import { findCustomerById } from '../customers/customers.repository.js';
import { findOrderById } from '../orders/orders.repository.js';
import { logActivity } from '../staff/staff-activity.repository.js';
import { getArchivedMedia, type ArchivedMedia } from '../../services/s3/media.js';

export async function logPayment(
  data: CreatePaymentInput,
  businessId: string,
  loggedById: string | null,
): Promise<repository.PaymentWithCustomer> {
  // Both lookups are tenant-scoped, so a caller cannot attach a payment to
  // another business's customer or order by guessing an id.
  const customer = await findCustomerById(data.customerId, businessId);
  if (!customer) {
    throw new NotFoundError('Customer not found');
  }

  if (data.orderId) {
    const order = await findOrderById(data.orderId, businessId);
    if (!order) {
      throw new NotFoundError('Order not found');
    }
  }

  const payment = await repository.createPayment(data, businessId, loggedById);

  if (payment.confidence !== 'CLAIMED') {
    // Customer-facing notices only ever describe money coming IN. Firing
    // "payment received" on a refund (direction OUT) would write a false
    // statement into the customer's WhatsApp history at the exact moment
    // money went the other way — precisely the artefact a dispute turns on.
    // A refund-specific template is later-phase work; until it exists, a
    // refund stays silent on this channel. Do not remove this guard to
    // "fix" a missing refund notice — add the template instead.
    if (payment.direction === 'IN') {
      emitPaymentConfirmed(businessId, {
        paymentId: payment.id,
        orderId: payment.orderId ?? '',
        amount: Number(payment.amount),
      });

      await notifyPaymentReceived(payment.id);
      await notifyOwnerPaymentRecorded(payment.id);
    }

    await logActivity({
      staffId: loggedById ?? 'owner',
      action: payment.direction === 'OUT' ? 'payment.refunded' : 'payment.logged',
      resourceId: payment.id,
      resourceType: 'payment',
      note: `${payment.direction === 'OUT' ? 'Refund' : 'Payment'} of GHS ${Number(payment.amount).toFixed(2)} logged`,
    }).catch(() => {});
  }

  return payment;
}

export async function attestPayment(
  paymentId: string,
  businessId: string,
  attestedBy: string,
): Promise<repository.PaymentWithCustomer> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  // A claim recorded from a screenshot has no amount yet. Attesting it as it
  // stands would write GHS 0.00 into the customer's record and send them a
  // receipt saying so — a false statement in the one artefact a dispute turns
  // on. Those go through `confirmPayment`, which makes someone read the figure.
  if (Number(payment.amount) <= 0) {
    throw new ValidationError(
      'This claim has no amount yet — confirm it with the amount shown on the screenshot',
    );
  }

  const attested = await repository.attestPaymentWithSideEffects(paymentId, businessId, attestedBy);
  if (!attested) {
    // The conditional claim did not land: someone else attested it, or it was
    // voided between the read and the write.
    throw new ValidationError('Payment has already been attested or voided');
  }

  await announceAttestation(attested, businessId, attestedBy, 'attested as received');

  return attested;
}

/**
 * Turns a claim into money: the owner reads the amount and method off the
 * screenshot, optionally attaches it to an order, and attests it in one step.
 *
 * The PRD's review flow in two taps. Everything after the write is the same
 * announcement an ordinary attestation makes, so a confirmed screenshot behaves
 * exactly like a payment the owner logged by hand — same receipt to the
 * customer, same audit entry, same totals.
 */
export async function confirmPayment(
  paymentId: string,
  businessId: string,
  data: ConfirmPaymentInput,
  confirmedBy: string,
): Promise<repository.PaymentWithCustomer> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  // Tenant-scoped, so a caller cannot attach a claim to another business's
  // order by guessing an id.
  if (data.orderId) {
    const order = await findOrderById(data.orderId, businessId);
    if (!order) {
      throw new NotFoundError('Order not found');
    }
  }

  const confirmed = await repository.confirmClaimWithSideEffects(
    paymentId,
    businessId,
    data,
    confirmedBy,
  );
  if (!confirmed) {
    throw new ValidationError('Payment has already been attested or voided');
  }

  if (confirmed.screenshotKey) {
    await clearScreenshotReviewFlag(businessId, confirmed.screenshotKey);
  }

  await announceAttestation(confirmed, businessId, confirmedBy, 'confirmed from a screenshot');

  return confirmed;
}

/**
 * Everything that happens once money is attested, in one place.
 *
 * Shared by `attestPayment` and `confirmPayment` so the two cannot drift: when
 * a second confirmation path was written without this, the obvious mistake is
 * for it to skip a gate — most dangerously the direction check below.
 */
async function announceAttestation(
  payment: repository.PaymentWithCustomer,
  businessId: string,
  actor: string,
  what: string,
): Promise<void> {
  // See the matching guard in logPayment: a refund (direction OUT) must never
  // trigger the customer-facing "payment received" notice or the confirmed
  // event, even once attested. Refunds stay silent until a dedicated
  // refund-issued template exists.
  if (payment.direction === 'IN') {
    emitPaymentConfirmed(businessId, {
      paymentId: payment.id,
      orderId: payment.orderId ?? '',
      amount: Number(payment.amount),
    });
  }

  await logActivity({
    staffId: actor,
    action: 'payment.attested',
    resourceId: payment.id,
    resourceType: 'payment',
    note: `Payment of GHS ${Number(payment.amount).toFixed(2)} ${what}`,
  }).catch(() => {});

  if (payment.direction === 'IN') {
    await notifyPaymentReceived(payment.id);
    await notifyOwnerPaymentRecorded(payment.id);
  }
}

export async function voidPayment(
  paymentId: string,
  businessId: string,
  voidedBy: string,
  reason: string,
): Promise<void> {
  const payment = await repository.findPaymentById(paymentId, businessId);
  if (!payment) {
    throw new NotFoundError('Payment not found');
  }

  const didVoid = await repository.voidPayment(paymentId, businessId, voidedBy, reason);
  if (!didVoid) {
    throw new ValidationError('Payment is already voided');
  }

  // Dismissing a screenshot is a void with a reason, so the image and the
  // decision survive — and the message it arrived on stops asking to be read.
  if (payment.screenshotKey) {
    await clearScreenshotReviewFlag(businessId, payment.screenshotKey);
  }

  await logActivity({
    staffId: voidedBy,
    action: 'payment.voided',
    resourceId: paymentId,
    resourceType: 'payment',
    note: `Payment of GHS ${Number(payment.amount).toFixed(2)} voided: ${reason}`,
  }).catch(() => {});
}

/**
 * What the owner has to check: every live claim, screenshots and hand-logged
 * amounts alike.
 *
 * The "needs checking" tab used to filter on a non-null `screenshotUrl`, which
 * no code path ever wrote — so it was permanently empty and its badge
 * permanently zero, while ordinary unattested payments had nowhere to appear at
 * all.
 */
export async function getReviewQueue(
  businessId: string,
  query: ReviewQueueQueryInput,
): Promise<repository.ReviewQueueItem[]> {
  return repository.listReviewQueue(businessId, query.limit);
}

export async function listPayments(
  businessId: string,
  filters: ListPaymentsQueryInput,
): Promise<repository.PaymentWithCustomer[]> {
  // `attested` and `confidence` must agree, or the query is self-contradictory:
  // attested=true means "confidence is above CLAIMED", attested=false means
  // "confidence is CLAIMED". Rejecting the mismatch here is what stops the
  // repository from having to silently pick a winner between the two filters —
  // which used to mean one of them was clobbered and the caller got a
  // confidently wrong answer instead of an empty or explained one.
  if (filters.confidence && filters.attested !== undefined) {
    const confidenceImpliesAttested = filters.confidence !== 'CLAIMED';
    if (confidenceImpliesAttested !== filters.attested) {
      throw new ValidationError(
        `confidence=${filters.confidence} is incompatible with attested=${filters.attested}`,
      );
    }
  }

  return repository.listPayments(businessId, filters);
}

export async function getPaymentStats(businessId: string): Promise<{
  totalRevenue: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  byMethod: Record<string, number>;
}> {
  return repository.getRevenueStats(businessId);
}

/**
 * Serves a payment's screenshot back to the dashboard.
 *
 * The bucket is private and nothing here signs URLs, so the image cannot be
 * loaded from S3 by the browser directly. Reading it back through the API also
 * means the tenant check happens on every view rather than resting on the
 * obscurity of an object key.
 */
export async function readPaymentScreenshot(
  paymentId: string,
  businessId: string,
): Promise<ArchivedMedia> {
  const screenshot = await repository.findScreenshotKey(paymentId, businessId);

  if (!screenshot || !screenshot.archived) {
    throw new NotFoundError('No screenshot is stored for this payment');
  }

  const media = await getArchivedMedia(screenshot.key);
  if (!media) {
    throw new NotFoundError('The screenshot could not be read from storage');
  }

  return media;
}
