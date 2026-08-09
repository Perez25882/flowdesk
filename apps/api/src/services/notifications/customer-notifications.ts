import type { OrderStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { enqueueOutboundMessage } from '../../queues/outbound.queue.js';
import { canSendOutbound } from '../plan/plan.service.js';
import {
  formatAmount,
  getCustomerFirstName,
  getTemplateKeyForOrderStatus,
  humanizeStatus,
  isTemplateEnabled,
  parseTemplateConfig,
  renderTemplate,
  shouldSendAutoReply,
  type TemplateKey,
} from '../templates/template-engine.js';

/**
 * The single entry point for every automated message sent to a customer.
 *
 * Routing all auto-replies through here is what prevents the class of bug where
 * two call sites each send their own confirmation for the same event. Every
 * function is best-effort: a WhatsApp failure is logged, never propagated, so a
 * messaging outage cannot roll back a database transaction or fail an API call.
 */

export interface NotificationContext {
  businessId: string;
  businessName: string;
  templateConfig: ReturnType<typeof parseTemplateConfig>;
  customerId: string | null;
  customerWaNumber: string;
  customerName: string | null;
  lastInboundAt: Date | null;
  blacklisted: boolean;
  relatedOrderId?: string;
}

/** Why a message was not delivered. Machine-readable so callers can explain it. */
export type DeliverySuppressionReason =
  | 'blacklisted'
  | 'template_disabled'
  | 'owner_replying'
  | 'outside_service_window'
  | 'plan_allowance_exhausted';

export interface DeliveryDecision {
  allowed: boolean;
  reason?: DeliverySuppressionReason;
}

export interface EvaluateDeliveryOptions {
  /** Checked against the owner's disabled list. Omit for messages with no template. */
  templateKey?: TemplateKey;
  /**
   * Skip the human-takeover gate.
   *
   * Only for messages the owner (or their staff) typed themselves — refusing to
   * send a human's reply because a human recently replied is nonsense. Never set
   * this for automated messages.
   */
  humanInitiated?: boolean;
}

/**
 * The one place that decides whether a message may go to a customer.
 *
 * Extracted so that every send path — templated auto-replies, assistant-written
 * answers, and the owner's own dashboard replies — is judged by the same rules
 * in the same order. Historically each new send path re-implemented this and
 * quietly dropped a gate; returning a decision instead of sending keeps that
 * from happening again and lets an HTTP caller explain the refusal.
 */
export async function evaluateDelivery(
  context: NotificationContext,
  options: EvaluateDeliveryOptions = {},
): Promise<DeliveryDecision> {
  // 1. Owner has muted this contact.
  if (context.blacklisted) {
    return { allowed: false, reason: 'blacklisted' };
  }

  // 2. Owner switched this particular reply off.
  if (options.templateKey && !isTemplateEnabled(context.templateConfig, options.templateKey)) {
    return { allowed: false, reason: 'template_disabled' };
  }

  // 3. A human is already handling this conversation from the WhatsApp app.
  if (!options.humanInitiated && (await ownerRepliedRecently(context.customerId))) {
    return { allowed: false, reason: 'owner_replying' };
  }

  // 4. Meta only permits free-form messages inside the 24h window a customer
  //    message opens. Sending outside it fails and hurts the number's rating.
  if (!shouldSendAutoReply(context.lastInboundAt).withinWindow) {
    return { allowed: false, reason: 'outside_service_window' };
  }

  // 5. Plan allowance. Last, because inbound processing continues regardless —
  //    only automated outbound pauses, so no customer data is ever lost.
  if (!(await canSendOutbound(context.businessId))) {
    return { allowed: false, reason: 'plan_allowance_exhausted' };
  }

  return { allowed: true };
}

/** Human-readable log line for a suppression, kept next to the reasons themselves. */
const SUPPRESSION_LOG: Record<DeliverySuppressionReason, string> = {
  blacklisted: 'Auto-reply suppressed: customer is blacklisted',
  template_disabled: 'Auto-reply suppressed: template disabled by owner',
  owner_replying:
    'Auto-reply suppressed: owner is handling this conversation from the WhatsApp Business app',
  outside_service_window: 'Auto-reply suppressed: outside the 24-hour customer service window',
  plan_allowance_exhausted: 'Auto-reply suppressed: conversation allowance exhausted',
};

/**
 * How long the assistant stays quiet after the owner replies from their own
 * phone. Long enough to cover a back-and-forth exchange the owner is handling
 * personally, short enough that automation resumes without them doing anything.
 */
const HUMAN_TAKEOVER_WINDOW_MS = 15 * 60 * 1000;

/**
 * True when the owner has recently answered this customer from the WhatsApp
 * Business app (coexistence).
 *
 * Those sends reach us only as `smb_message_echoes`, so without this check the
 * assistant has no idea a human is already in the conversation and will reply
 * on top of them — the failure most likely to make an owner distrust the
 * product and switch it off.
 */
async function ownerRepliedRecently(customerId: string | null): Promise<boolean> {
  if (!customerId) {
    return false;
  }

  const since = new Date(Date.now() - HUMAN_TAKEOVER_WINDOW_MS);

  const recent = await prisma.message.findFirst({
    where: { customerId, sentFromApp: true, createdAt: { gt: since } },
    select: { id: true },
  });

  return recent !== null;
}

/**
 * Decides whether an auto-reply may be sent and queues it.
 *
 * Suppression rules, in order:
 *   1. Customer blacklisted   — owner has muted this contact.
 *   2. Template disabled      — owner switched this reply off.
 *   3. Owner already replying — human takeover from the WhatsApp Business app.
 *   4. Outside the 24h window — Meta only permits template messages there,
 *                               so a free-form send would be rejected.
 *   5. Plan allowance spent   — outbound pauses; inbound is unaffected.
 *
 * Delivery itself is the outbound worker's job, using the owning tenant's own
 * WhatsApp credentials.
 */
async function deliver(
  context: NotificationContext,
  key: TemplateKey,
  variables: Record<string, string>,
): Promise<void> {
  const text = renderTemplate(context.templateConfig, key, {
    name: getCustomerFirstName(context.customerName) || 'there',
    business: context.businessName,
    ...variables,
  });

  await deliverText(context, text, { templateKey: key });
}

/**
 * Sends a body that has already been composed — an assistant-written answer or a
 * server-composed question — through the same gates as a templated reply.
 *
 * Shares `evaluateDelivery` with `deliver()` deliberately: a second send path
 * that re-implemented the checks is exactly how a gate gets lost.
 */
export async function deliverText(
  context: NotificationContext,
  text: string,
  options: EvaluateDeliveryOptions = {},
): Promise<DeliveryDecision> {
  const decision = await evaluateDelivery(context, options);

  if (!decision.allowed) {
    const reason = decision.reason!;
    logger.info(
      {
        businessId: context.businessId,
        customerId: context.customerId,
        template: options.templateKey,
        reason,
      },
      SUPPRESSION_LOG[reason],
    );
    return decision;
  }

  try {
    await enqueueOutboundMessage({
      businessId: context.businessId,
      customerId: context.customerId,
      to: context.customerWaNumber,
      body: text,
      ...(options.templateKey ? { templateKey: options.templateKey } : {}),
      ...(context.relatedOrderId ? { relatedOrderId: context.relatedOrderId } : {}),
      // Automated sends abort if the owner starts replying by hand between now
      // and delivery. Human-initiated sends deliberately carry no such guard.
      ...(options.humanInitiated ? {} : { suppressIfOwnerRepliedSince: new Date().toISOString() }),
    });
  } catch (error: unknown) {
    // Failing to enqueue must not roll back the order that triggered it.
    logger.error(
      { error, businessId: context.businessId, template: options.templateKey },
      'Failed to queue customer message',
    );
  }

  return decision;
}

interface OrderNotificationRow {
  id: string;
  referenceNumber: string;
  status: OrderStatus;
  cancelReason: string | null;
  business: { id: string; name: string; replyTemplates: unknown };
  customer: {
    id: string;
    waNumber: string;
    name: string | null;
    lastInboundAt: Date | null;
    blacklisted: boolean;
  };
  assignedTo: { name: string } | null;
}

async function loadOrderContext(orderId: string): Promise<OrderNotificationRow | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      cancelReason: true,
      business: { select: { id: true, name: true, replyTemplates: true } },
      customer: {
        select: { id: true, waNumber: true, name: true, lastInboundAt: true, blacklisted: true },
      },
      assignedTo: { select: { name: true } },
    },
  }) as Promise<OrderNotificationRow | null>;
}

function toContext(row: OrderNotificationRow): NotificationContext {
  return {
    businessId: row.business.id,
    businessName: row.business.name,
    templateConfig: parseTemplateConfig(row.business.replyTemplates),
    customerId: row.customer.id,
    customerWaNumber: row.customer.waNumber,
    customerName: row.customer.name,
    lastInboundAt: row.customer.lastInboundAt,
    blacklisted: row.customer.blacklisted,
    relatedOrderId: row.id,
  };
}

/**
 * Notifies the customer that their order reached a new status. Called on every
 * lifecycle transition so the customer is kept informed without the owner
 * typing anything.
 */
export async function notifyOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
  const key = getTemplateKeyForOrderStatus(status);
  if (!key) return;

  const row = await loadOrderContext(orderId).catch((error: unknown) => {
    logger.error({ error, orderId }, 'Failed to load order for status notification');
    return null;
  });

  if (!row) return;

  await deliver(toContext(row), key, {
    ref: row.referenceNumber,
    reason: row.cancelReason ?? '',
    status: humanizeStatus(status),
  });
}

/** Replies to a customer asking about an existing order. */
export async function notifyOrderStatusCheck(orderId: string): Promise<void> {
  const row = await loadOrderContext(orderId).catch(() => null);
  if (!row) return;

  await deliver(toContext(row), 'status_check_response', {
    ref: row.referenceNumber,
    status: humanizeStatus(row.status),
    details: row.assignedTo ? `Assigned to ${row.assignedTo.name}.` : '',
  });
}

/** Sends the receipt that follows a verified payment. */
export async function notifyPaymentReceived(paymentId: string): Promise<void> {
  const payment = await prisma.payment
    .findUnique({
      where: { id: paymentId },
      select: {
        amount: true,
        business: { select: { id: true, name: true, replyTemplates: true } },
        customer: {
          select: { id: true, waNumber: true, name: true, lastInboundAt: true, blacklisted: true },
        },
        order: { select: { id: true, referenceNumber: true } },
      },
    })
    .catch((error: unknown) => {
      logger.error({ error, paymentId }, 'Failed to load payment for receipt');
      return null;
    });

  if (!payment) return;

  const context: NotificationContext = {
    businessId: payment.business.id,
    businessName: payment.business.name,
    templateConfig: parseTemplateConfig(payment.business.replyTemplates),
    customerId: payment.customer.id,
    customerWaNumber: payment.customer.waNumber,
    customerName: payment.customer.name,
    lastInboundAt: payment.customer.lastInboundAt,
    blacklisted: payment.customer.blacklisted,
    ...(payment.order ? { relatedOrderId: payment.order.id } : {}),
  };

  await deliver(context, 'payment_received', {
    amount: formatAmount(Number(payment.amount)).replace('GHS ', ''),
    ref: payment.order?.referenceNumber ?? 'your account',
  });
}

/**
 * Loads the delivery context for a customer.
 *
 * Shared rather than duplicated so the assistant runs through the same gates as
 * every templated reply. A second, hand-rolled context is how one of these paths
 * quietly ends up missing the blacklist or the takeover check.
 */
export async function loadNotificationContext(
  businessId: string,
  customerId: string,
): Promise<NotificationContext | null> {
  const [business, customer] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true, replyTemplates: true },
    }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { waNumber: true, name: true, lastInboundAt: true, blacklisted: true },
    }),
  ]);

  if (!business || !customer) return null;

  return {
    businessId: business.id,
    businessName: business.name,
    templateConfig: parseTemplateConfig(business.replyTemplates),
    customerId,
    customerWaNumber: customer.waNumber,
    customerName: customer.name,
    lastInboundAt: customer.lastInboundAt,
    blacklisted: customer.blacklisted,
  };
}

/**
 * Replies to a non-order message (greeting, inquiry, complaint, …). Kept
 * separate from the order flow because it is driven by intent, not by a record.
 */
export async function notifyIntentReply(
  businessId: string,
  customerId: string,
  key: TemplateKey,
): Promise<void> {
  const context = await loadNotificationContext(businessId, customerId);
  if (!context) return;

  await deliver(context, key, {});
}

/**
 * Free-form reply used when no template applies — currently the "order not
 * found" response to a status check for an unknown reference.
 */
export async function notifyUnknownOrderReference(
  businessId: string,
  customerId: string,
  reference: string,
): Promise<void> {
  const [business, customer] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, replyTemplates: true },
    }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { waNumber: true, name: true, blacklisted: true, lastInboundAt: true },
    }),
  ]);

  if (!business || !customer) return;

  const text = `We couldn't find order ${reference}. Please check the reference number or contact us. — ${business.name}`;

  // Routed through deliverText rather than its own checks. Hand-rolled here, it
  // had drifted out of sync and was missing the owner-takeover gate — so it
  // could talk over an owner already answering this exact question by hand.
  await deliverText(
    {
      businessId,
      businessName: business.name,
      templateConfig: parseTemplateConfig(business.replyTemplates),
      customerId,
      customerWaNumber: customer.waNumber,
      customerName: customer.name,
      lastInboundAt: customer.lastInboundAt,
      blacklisted: customer.blacklisted,
    },
    text,
  );
}
