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

interface NotificationContext {
  businessId: string;
  businessName: string;
  templateConfig: ReturnType<typeof parseTemplateConfig>;
  customerId: string | null;
  customerWaNumber: string;
  customerName: string | null;
  lastInteractionAt: Date | null;
  blacklisted: boolean;
  relatedOrderId?: string;
}

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

  if (context.blacklisted) {
    logger.info(
      { businessId: context.businessId, template: key },
      'Auto-reply suppressed: customer is blacklisted',
    );
    return;
  }

  if (!isTemplateEnabled(context.templateConfig, key)) {
    logger.debug(
      { businessId: context.businessId, template: key },
      'Auto-reply suppressed: template disabled by owner',
    );
    return;
  }

  if (await ownerRepliedRecently(context.customerId)) {
    logger.info(
      { businessId: context.businessId, customerId: context.customerId, template: key },
      'Auto-reply suppressed: owner is handling this conversation from the WhatsApp Business app',
    );
    return;
  }

  if (!shouldSendAutoReply(context.lastInteractionAt).withinWindow) {
    logger.info(
      { businessId: context.businessId, template: key },
      'Auto-reply suppressed: outside the 24-hour customer service window',
    );
    return;
  }

  // Plan allowance is the last gate. Inbound processing continues regardless —
  // only automated outbound pauses, so no customer data is ever lost.
  if (!(await canSendOutbound(context.businessId))) {
    logger.warn(
      { businessId: context.businessId, template: key },
      'Auto-reply suppressed: conversation allowance exhausted',
    );
    return;
  }

  const text = renderTemplate(context.templateConfig, key, {
    name: getCustomerFirstName(context.customerName) || 'there',
    business: context.businessName,
    ...variables,
  });

  try {
    await enqueueOutboundMessage({
      businessId: context.businessId,
      customerId: context.customerId,
      to: context.customerWaNumber,
      body: text,
      templateKey: key,
      ...(context.relatedOrderId ? { relatedOrderId: context.relatedOrderId } : {}),
    });
  } catch (error: unknown) {
    // Failing to enqueue must not roll back the order that triggered it.
    logger.error(
      { error, businessId: context.businessId, template: key },
      'Failed to queue customer auto-reply',
    );
  }
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
    lastInteractionAt: Date | null;
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
        select: { id: true, waNumber: true, name: true, lastInteractionAt: true, blacklisted: true },
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
    lastInteractionAt: row.customer.lastInteractionAt,
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
          select: { id: true, waNumber: true, name: true, lastInteractionAt: true, blacklisted: true },
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
    lastInteractionAt: payment.customer.lastInteractionAt,
    blacklisted: payment.customer.blacklisted,
    ...(payment.order ? { relatedOrderId: payment.order.id } : {}),
  };

  await deliver(context, 'payment_received', {
    amount: formatAmount(Number(payment.amount)).replace('GHS ', ''),
    ref: payment.order?.referenceNumber ?? 'your account',
  });
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
  const [business, customer] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true, replyTemplates: true },
    }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { waNumber: true, name: true, lastInteractionAt: true, blacklisted: true },
    }),
  ]);

  if (!business || !customer) return;

  await deliver(
    {
      businessId: business.id,
      businessName: business.name,
      templateConfig: parseTemplateConfig(business.replyTemplates),
      customerId,
      customerWaNumber: customer.waNumber,
      customerName: customer.name,
      lastInteractionAt: customer.lastInteractionAt,
      blacklisted: customer.blacklisted,
    },
    key,
    {},
  );
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
    prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { waNumber: true, blacklisted: true, lastInteractionAt: true },
    }),
  ]);

  if (!business || !customer || customer.blacklisted) return;

  if (!shouldSendAutoReply(customer.lastInteractionAt).withinWindow) return;
  if (!(await canSendOutbound(businessId))) return;

  const text = `We couldn't find order ${reference}. Please check the reference number or contact us. — ${business.name}`;

  try {
    await enqueueOutboundMessage({
      businessId,
      customerId,
      to: customer.waNumber,
      body: text,
    });
  } catch (error: unknown) {
    logger.error({ error, businessId, reference }, 'Failed to queue unknown-reference reply');
  }
}
