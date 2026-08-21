import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { enqueueOutboundMessage } from '../../queues/outbound.queue.js';
import { maskPhone, normalizeGhanaPhone } from '../../utils/phone.js';
import { canSendOutbound } from '../plan/plan.service.js';
import { shouldSendAutoReply } from '../templates/template-engine.js';
import { loadTenantCredentials, sendTemplate } from '../whatsapp/client.js';

/**
 * The single entry point for every message Flowdesk sends to a business OWNER.
 *
 * Deliberately a sibling of `customer-notifications.ts` rather than part of it:
 * the audience, the gates and the Meta rules are different. What is copied is
 * the discipline — every send funnels through one `evaluateDelivery`, so a
 * second call site cannot re-implement the checks and quietly lose one, and
 * every function is best-effort. An owner alert failing must never roll back
 * the order, stock adjustment or payment that triggered it.
 *
 * The hard part here is Meta's 24-hour window. The owner's own number has
 * usually never messaged the shop's WhatsApp number, so the window has never
 * opened for them and a free-form send is rejected with 131047 — classified
 * non-retryable, dead-lettered, and invisible to the owner. That is exactly the
 * bug that made staff invites vanish. So this module picks its channel: a
 * free-form text when the owner happens to be inside an open window (they did
 * message the shop), and an approved message template when they are not.
 *
 * The templates named in {@link OWNER_TEMPLATES} must exist and be approved in
 * the tenant's own WhatsApp Business Account. Until they do, Meta rejects the
 * send with error 132001 and the failure is logged as a send failure — nothing
 * pretends the owner was told.
 */

export type OwnerNotificationKind = 'new_order' | 'low_stock' | 'payment';

/**
 * How long a kind stays quiet after an alert goes out.
 *
 * A shop taking forty orders in an hour must not send its owner forty WhatsApp
 * messages: that is a phone nobody wants, a conversation charge per message,
 * and the fastest way to get the number's quality rating cut. So the first
 * event of a kind is delivered immediately — latency is the whole point of the
 * feature — and everything within the cooldown is counted rather than sent. The
 * count is folded into the next alert ("That makes 13 new orders since your
 * last alert"), which is why nothing is silently dropped: a suppressed event
 * still shows up in the next message the owner receives.
 *
 * Per kind, not global, because they are urgent on different timescales. A new
 * order wants minutes. A reorder level does not: the stock will still be low in
 * two hours, and a stream of stock alerts is what trains an owner to ignore the
 * channel entirely.
 */
const COOLDOWN_SECONDS: Record<OwnerNotificationKind, number> = {
  new_order: 10 * 60,
  low_stock: 2 * 60 * 60,
  payment: 15 * 60,
};

export interface OwnerTemplate {
  /** Name the template must be created under in Meta Business Manager. */
  name: string;
  /** Language code the template is registered in. */
  language: string;
  /**
   * The approved body, verbatim, with Meta's positional placeholders.
   *
   * Kept here as data rather than as prose in a doc because it is also rendered
   * locally for the free-form path — so the owner reads identical wording
   * whichever channel carried it, and the two can never drift apart. When this
   * string changes, the template in Meta has to be resubmitted to match.
   */
  body: string;
}

/**
 * What an operator must create in Meta Business Manager, per WhatsApp Business
 * Account, before owner alerts can reach anyone outside the 24-hour window.
 * All three are UTILITY (they report an event in the owner's own account, not
 * marketing) and English.
 */
export const OWNER_TEMPLATES: Record<OwnerNotificationKind, OwnerTemplate> = {
  new_order: {
    name: 'flowdesk_owner_new_order',
    language: 'en',
    body: 'New order {{1}} at {{2}}: {{3}}, total GHS {{4}}. That makes {{5}} since your last alert. Open Flowdesk to confirm it.',
  },
  low_stock: {
    name: 'flowdesk_owner_low_stock',
    language: 'en',
    body: 'Stock alert at {{1}}: {{2}} is down to {{3}} left, at or below your reorder level of {{4}}. That makes {{5}} since your last alert. Open Flowdesk to restock.',
  },
  payment: {
    name: 'flowdesk_owner_payment',
    language: 'en',
    body: 'Payment of GHS {{1}} recorded at {{2}} from {{3}} for {{4}}. That makes {{5}} since your last alert. Open Flowdesk to see it.',
  },
};

/** Why an owner alert was not sent. Machine-readable so callers can explain it. */
type OwnerSuppressionReason =
  | 'preference_off'
  | 'no_owner_phone'
  | 'plan_allowance_exhausted'
  | 'cooling_down';

interface OwnerDeliveryDecision {
  allowed: boolean;
  reason?: OwnerSuppressionReason;
  /** Events of this kind suppressed by the cooldown since the last alert. */
  coalesced: number;
}

const SUPPRESSION_LOG: Record<OwnerSuppressionReason, string> = {
  preference_off: 'Owner alert suppressed: the owner switched this notification off',
  no_owner_phone: 'Owner alert suppressed: business has no owner phone number recorded',
  plan_allowance_exhausted: 'Owner alert suppressed: conversation allowance exhausted',
  cooling_down: 'Owner alert suppressed: within the cooldown, counted into the next alert',
};

interface OwnerContext {
  businessId: string;
  businessName: string;
  /** The owner's own WhatsApp number, normalised. Null when never recorded. */
  ownerPhone: string | null;
  preferences: Record<OwnerNotificationKind, boolean>;
  /**
   * When the owner last messaged their own shop number, if they ever have.
   *
   * Owners are not customers, but an owner who has texted their own number to
   * test it does have a `Customer` row, and that row's `lastInboundAt` is the
   * only honest basis for deciding whether Meta's window is open for them.
   * Null — the normal case — means the window has never opened and the template
   * path is the only one that can deliver.
   */
  ownerLastInboundAt: Date | null;
}

/**
 * Loads everything the gates need in one place.
 *
 * Returns null only when the business row is gone; a business with no owner
 * phone still produces a context, because "no phone" is a suppression the gate
 * has to report, not a reason to be missing.
 */
async function loadOwnerContext(businessId: string): Promise<OwnerContext | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      phone: true,
      notifyOnNewOrder: true,
      notifyOnLowStock: true,
      notifyOnPayment: true,
    },
  });

  if (!business) return null;

  const ownerPhone = business.phone ? normalizeGhanaPhone(business.phone) : '';

  const ownerAsCustomer = ownerPhone
    ? await prisma.customer.findFirst({
        where: { businessId, waNumber: ownerPhone },
        select: { lastInboundAt: true },
      })
    : null;

  return {
    businessId: business.id,
    businessName: business.name,
    ownerPhone: ownerPhone.length > 0 ? ownerPhone : null,
    preferences: {
      new_order: business.notifyOnNewOrder,
      low_stock: business.notifyOnLowStock,
      payment: business.notifyOnPayment,
    },
    ownerLastInboundAt: ownerAsCustomer?.lastInboundAt ?? null,
  };
}

function cooldownKey(businessId: string, kind: OwnerNotificationKind): string {
  return `flowdesk:owner-notify:cooldown:${businessId}:${kind}`;
}

function backlogKey(businessId: string, kind: OwnerNotificationKind): string {
  return `flowdesk:owner-notify:backlog:${businessId}:${kind}`;
}

/**
 * Claims the right to send one alert of this kind, or counts this event into
 * the backlog that the next alert will report.
 *
 * The claim is a `SET NX EX`, so it holds across API instances and workers —
 * two processes handling two orders in the same second cannot both decide they
 * are first. The backlog counter's TTL slides on every increment: a steady
 * stream keeps it alive until it is folded into the next message, while a shop
 * that goes quiet for a full cooldown drops it, because "9 orders since your
 * last alert" is misleading when they arrived yesterday.
 *
 * A Redis failure lets the alert through. That is the same trade the outbound
 * send throttle makes, and it costs little here: BullMQ runs on this same
 * Redis, so an outage stops delivery long before duplicate alerts become a
 * problem.
 */
async function reserveAlertSlot(
  businessId: string,
  kind: OwnerNotificationKind,
): Promise<{ allowed: boolean; coalesced: number }> {
  const cooldown = COOLDOWN_SECONDS[kind];

  try {
    const claimed = await redis.set(cooldownKey(businessId, kind), '1', 'EX', cooldown, 'NX');

    if (claimed !== 'OK') {
      const key = backlogKey(businessId, kind);
      await redis.multi().incr(key).expire(key, cooldown).exec();
      return { allowed: false, coalesced: 0 };
    }

    const key = backlogKey(businessId, kind);
    const results = await redis.multi().get(key).del(key).exec();
    const raw = results?.[0]?.[1];
    const backlog = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;

    return { allowed: true, coalesced: Number.isFinite(backlog) ? backlog : 0 };
  } catch (error: unknown) {
    logger.warn({ error, businessId, kind }, 'Owner alert cooldown unavailable — sending anyway');
    return { allowed: true, coalesced: 0 };
  }
}

/**
 * The one place that decides whether an owner alert may be sent.
 *
 * Order matters. The preference and the phone number are free to check, so they
 * come first. The plan allowance is checked before the cooldown because
 * claiming a cooldown slot is a side effect: burning it on a message the plan
 * would have blocked would silence the kind for the rest of the cooldown for
 * nothing.
 */
async function evaluateDelivery(
  context: OwnerContext,
  kind: OwnerNotificationKind,
): Promise<OwnerDeliveryDecision> {
  // 1. Owner switched this notification off in Settings.
  if (!context.preferences[kind]) {
    return { allowed: false, reason: 'preference_off', coalesced: 0 };
  }

  // 2. No owner phone recorded. Nothing to send to — degrade quietly, because
  //    this runs inside a queue worker and inside order creation.
  if (!context.ownerPhone) {
    return { allowed: false, reason: 'no_owner_phone', coalesced: 0 };
  }

  // 3. Suspended business or spent conversation allowance. Same rule the
  //    customer path applies, and for the same reason: outbound pauses, the
  //    underlying record is still written.
  if (!(await canSendOutbound(context.businessId))) {
    return { allowed: false, reason: 'plan_allowance_exhausted', coalesced: 0 };
  }

  // 4. Cooldown, last, because it consumes a slot.
  const slot = await reserveAlertSlot(context.businessId, kind);
  if (!slot.allowed) {
    return { allowed: false, reason: 'cooling_down', coalesced: 0 };
  }

  return { allowed: true, coalesced: slot.coalesced };
}

/** The four kind-specific body variables; the activity count is appended as the fifth. */
type AlertVariables = [string, string, string, string];

/** Plural noun for the activity count, so `{{5}}` reads as a phrase either way. */
const ACTIVITY_NOUN: Record<OwnerNotificationKind, { one: string; many: string }> = {
  new_order: { one: 'new order', many: 'new orders' },
  low_stock: { one: 'stock alert', many: 'stock alerts' },
  payment: { one: 'payment', many: 'payments' },
};

function activityPhrase(kind: OwnerNotificationKind, coalesced: number): string {
  const total = coalesced + 1;
  const noun = ACTIVITY_NOUN[kind];
  return total === 1 ? `1 ${noun.one}` : `${total} ${noun.many}`;
}

function renderBody(body: string, variables: string[]): string {
  return variables.reduce(
    (text, value, index) => text.replaceAll(`{{${index + 1}}}`, value),
    body,
  );
}

/**
 * Sends one owner alert, choosing the channel Meta will actually accept.
 *
 * Inside the 24-hour window the message goes through the outbound queue as a
 * normal text, which buys retries, the sent-message record and conversation
 * accounting. Outside it — the usual case for an owner — the queue cannot help:
 * its job shape only carries free-form text and the worker only calls
 * `sendText`, so a queued alert would be rejected by Meta and dead-lettered.
 * The template therefore goes straight out through the tenant's own
 * credentials. It is the slower path, which is why it sits behind the cooldown
 * and behind every other gate.
 */
async function deliver(
  context: OwnerContext,
  kind: OwnerNotificationKind,
  variables: AlertVariables,
): Promise<OwnerDeliveryDecision> {
  const decision = await evaluateDelivery(context, kind);

  if (!decision.allowed) {
    const reason = decision.reason!;
    logger.info(
      { businessId: context.businessId, kind, reason },
      SUPPRESSION_LOG[reason],
    );
    return decision;
  }

  const template = OWNER_TEMPLATES[kind];
  const values = [...variables, activityPhrase(kind, decision.coalesced)];
  const to = context.ownerPhone!;

  if (shouldSendAutoReply(context.ownerLastInboundAt).withinWindow) {
    await enqueueOutboundMessage({
      businessId: context.businessId,
      // Not attributed to a customer: an owner alert is not part of anyone's
      // conversation, and threading it into one would put a message the
      // customer never received into their history.
      customerId: null,
      to,
      body: renderBody(template.body, values),
    });

    logger.info({ businessId: context.businessId, kind }, 'Owner alert queued as free-form text');
    return decision;
  }

  const credentials = await loadTenantCredentials(context.businessId);

  if (!credentials) {
    // Not connected, or a connection Meta has rejected. `loadTenantCredentials`
    // has already logged and recorded the state the owner sees in Settings.
    return decision;
  }

  const result = await sendTemplate(credentials, to, template.name, template.language, [
    { type: 'body', parameters: values.map((text) => ({ type: 'text', text })) },
  ]);

  logger.info(
    {
      businessId: context.businessId,
      kind,
      template: template.name,
      to: maskPhone(to),
      waMessageId: result.waMessageId,
    },
    'Owner alert sent as an approved template',
  );

  return decision;
}

/**
 * Runs one notification attempt with a hard guarantee that nothing escapes.
 *
 * Every caller is in the middle of doing the thing the owner actually cares
 * about — creating an order, adjusting stock, recording a payment. A missing
 * owner phone, an unapproved template or a Meta outage must cost them a log
 * line, never the record itself.
 */
async function attempt(
  kind: OwnerNotificationKind,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
  } catch (error: unknown) {
    logger.error({ error, kind }, 'Owner notification failed');
  }
}

/**
 * Tells the owner a new order has arrived.
 *
 * Call after the order row exists and is visible to a second connection —
 * outside the creating transaction, next to the SSE emit.
 */
export async function notifyOwnerNewOrder(orderId: string): Promise<void> {
  await attempt('new_order', async () => {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        businessId: true,
        referenceNumber: true,
        totalAmount: true,
        customer: { select: { name: true } },
      },
    });

    if (!order) return;

    const context = await loadOwnerContext(order.businessId);
    if (!context) return;

    await deliver(context, 'new_order', [
      order.referenceNumber,
      context.businessName,
      order.customer?.name ?? 'a customer',
      Number(order.totalAmount).toFixed(2),
    ]);
  });
}

/**
 * Tells the owner a product has reached or fallen below its reorder level.
 *
 * Call wherever the stock alert is already raised, so the WhatsApp message and
 * the dashboard alert are triggered by the same condition rather than by two
 * thresholds that can drift apart.
 */
export async function notifyOwnerLowStock(productId: string): Promise<void> {
  await attempt('low_stock', async () => {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        businessId: true,
        name: true,
        unit: true,
        stockQuantity: true,
        reorderThreshold: true,
      },
    });

    if (!product) return;

    const context = await loadOwnerContext(product.businessId);
    if (!context) return;

    await deliver(context, 'low_stock', [
      context.businessName,
      product.name,
      `${formatQuantity(product.stockQuantity)} ${product.unit}`,
      `${formatQuantity(product.reorderThreshold)} ${product.unit}`,
    ]);
  });
}

/**
 * Tells the owner money has been recorded against the business.
 *
 * Refunds are excluded here as well as at the call site. "Payment recorded"
 * fired on a payment going the other way is a false statement about money, and
 * the guard is cheap enough to keep on both sides of the boundary.
 */
export async function notifyOwnerPaymentRecorded(paymentId: string): Promise<void> {
  await attempt('payment', async () => {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        businessId: true,
        amount: true,
        direction: true,
        customer: { select: { name: true } },
        order: { select: { referenceNumber: true } },
      },
    });

    if (!payment || payment.direction !== 'IN') return;

    const context = await loadOwnerContext(payment.businessId);
    if (!context) return;

    await deliver(context, 'payment', [
      Number(payment.amount).toFixed(2),
      context.businessName,
      payment.customer?.name ?? 'a customer',
      payment.order ? `order ${payment.order.referenceNumber}` : 'no specific order',
    ]);
  });
}

/**
 * Stock is a Decimal with three places, so a bag count arrives as "12.000".
 * Trailing zeros are noise in a WhatsApp message; fractional units are not.
 */
function formatQuantity(value: unknown): string {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return String(value);
  return quantity.toFixed(3).replace(/\.?0+$/, '');
}
