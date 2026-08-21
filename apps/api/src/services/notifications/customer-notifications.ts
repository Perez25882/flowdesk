import type { OrderStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import {
  enqueueOutboundMessage,
  type OutboundTemplate,
} from '../../queues/outbound.queue.js';
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

/** Which of Meta's two message types this send is allowed to use. */
export type DeliveryChannel = 'free_form' | 'template';

export interface DeliveryDecision {
  allowed: boolean;
  reason?: DeliverySuppressionReason;
  /**
   * How the message may go out. Only meaningful when `allowed` — `template`
   * means the 24-hour window has closed and Meta will accept nothing else.
   */
  channel?: DeliveryChannel;
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
  /**
   * The approved Meta template to fall back to when the window has closed.
   *
   * Supplying it is what turns "outside the service window" from a refusal into
   * a change of channel. It is deliberately opt-in per send rather than a
   * property of the gate: an assistant-written answer has no approved template
   * and never will, so it must still be refused there, and refusing it is only
   * safe as long as the gate keeps saying no by default.
   */
  templateFallback?: OutboundTemplate;
  /**
   * Collapses repeat deliveries of one event onto a single queued job.
   *
   * Only for sends that can correctly happen once — the courtesy reply to a
   * given inbound message. Never for anything a person may repeat on purpose;
   * see the note on `EnqueueOptions.idempotencyKey`.
   */
  idempotencyKey?: string;
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
  //    message opens. Outside it an approved template is the only thing that
  //    will be delivered — so this is a choice of channel, not a refusal, for
  //    any send that has one. A send without a template is still refused,
  //    because the alternative is a message Meta rejects and a number whose
  //    quality rating pays for it.
  const channel: DeliveryChannel = shouldSendAutoReply(context.lastInboundAt).withinWindow
    ? 'free_form'
    : 'template';

  if (channel === 'template' && !options.templateFallback) {
    return { allowed: false, reason: 'outside_service_window' };
  }

  // 5. Plan allowance. Last, because inbound processing continues regardless —
  //    only automated outbound pauses, so no customer data is ever lost. Meta
  //    bills a template conversation exactly as it bills a free-form one, so
  //    this gate applies to both channels.
  if (!(await canSendOutbound(context.businessId))) {
    return { allowed: false, reason: 'plan_allowance_exhausted' };
  }

  return { allowed: true, channel };
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

/** The variables a customer template's numbered placeholders stand in for. */
type TemplateVariableName = 'name' | 'ref' | 'business' | 'amount' | 'reason';

export interface CustomerTemplate {
  /** Name the template must be created under in Meta Business Manager. */
  name: string;
  /** Language code the template is registered in. */
  language: string;
  /**
   * The approved body, verbatim, with Meta's positional placeholders.
   *
   * Kept here as data so it can be diffed against the wording in
   * `template-engine.ts` that the free-form path renders. A customer must read
   * the same sentence whichever channel carried it; if these two drift, the
   * same order confirmation says two different things depending on what time of
   * day it was confirmed.
   */
  body: string;
  /** Which variable fills `{{1}}`, `{{2}}`, … in that order. */
  variables: readonly TemplateVariableName[];
}

/**
 * What an operator must create, per WhatsApp Business Account, before customer
 * notifications can reach anyone outside the 24-hour service window.
 *
 * All UTILITY and English: each one reports the progress of an order the
 * customer themselves placed, which is what UTILITY means. Marketing would be
 * both wrong and opt-in.
 *
 * Only the lifecycle notifications are here, and the omissions are deliberate.
 * `greeting`, `inquiry`, `payment`, `complaint`, `fallback` and
 * `status_check_response` are all answers to a message the customer has just
 * sent, so the window is open by construction — a template for them would never
 * be used. Assistant-written replies are not here for a stronger reason: their
 * text is generated per conversation and no fixed template could carry it, so
 * outside the window they remain refused and become a draft for the owner.
 *
 * The owner's own wording overrides (`Business.replyTemplates`) apply to the
 * free-form path only. Meta approves a fixed string, so outside the window the
 * customer reads the wording below rather than the owner's edit.
 */
export const CUSTOMER_TEMPLATES: Partial<Record<TemplateKey, CustomerTemplate>> = {
  order_pending: {
    name: 'flowdesk_order_pending',
    language: 'en',
    body: "Hi {{1}}! We received your order (Ref: {{2}}). We'll confirm shortly. — {{3}}",
    variables: ['name', 'ref', 'business'],
  },
  order_confirmed: {
    name: 'flowdesk_order_confirmed',
    language: 'en',
    body: "Your order {{1}} is confirmed and being prepared. We'll let you know when it's ready. — {{2}}",
    variables: ['ref', 'business'],
  },
  order_processing: {
    name: 'flowdesk_order_processing',
    language: 'en',
    body: 'Your order {{1}} is being packed and prepared for delivery/pickup. — {{2}}',
    variables: ['ref', 'business'],
  },
  order_fulfilled: {
    name: 'flowdesk_order_fulfilled',
    language: 'en',
    body: 'Your order {{1}} has been completed. Thank you for your business! — {{2}}',
    variables: ['ref', 'business'],
  },
  order_cancelled: {
    name: 'flowdesk_order_cancelled',
    language: 'en',
    body: 'Your order {{1}} has been cancelled. {{2}} Please contact us if you have questions. — {{3}}',
    variables: ['ref', 'reason', 'business'],
  },
  payment_received: {
    name: 'flowdesk_payment_received',
    language: 'en',
    body: 'Payment of GHS {{1}} received for order {{2}}. Thank you! — {{3}}',
    variables: ['amount', 'ref', 'business'],
  },
};

/**
 * What a parameter says when the value behind it is blank.
 *
 * Meta rejects an empty parameter outright, which would turn one missing
 * cancellation reason into a message that never arrives. The free-form path
 * renders the same blank as an empty string and reads slightly differently as a
 * result; that is the one place the two channels do not match word for word,
 * and it is preferable to a send Meta refuses.
 */
const EMPTY_PARAMETER_TEXT: Record<TemplateVariableName, string> = {
  name: 'there',
  ref: 'your order',
  business: 'us',
  amount: '0.00',
  reason: 'No reason was given.',
};

/**
 * Turns the variables a reply was rendered from into ordered Meta parameters.
 *
 * Whitespace is collapsed because Meta rejects a parameter containing a newline,
 * a tab, or four consecutive spaces — none of which is visible in the value that
 * carries it, so the rejection would otherwise look random.
 */
function resolveTemplateFallback(
  key: TemplateKey,
  values: Record<string, string>,
): OutboundTemplate | null {
  const template = CUSTOMER_TEMPLATES[key];
  if (!template) return null;

  return {
    name: template.name,
    language: template.language,
    parameters: template.variables.map((variable) => {
      const collapsed = (values[variable] ?? '').replace(/\s+/g, ' ').trim();
      return collapsed.length > 0 ? collapsed : EMPTY_PARAMETER_TEXT[variable];
    }),
  };
}

/**
 * Decides whether an auto-reply may be sent and queues it.
 *
 * Suppression rules, in order:
 *   1. Customer blacklisted   — owner has muted this contact.
 *   2. Template disabled      — owner switched this reply off.
 *   3. Owner already replying — human takeover from the WhatsApp Business app.
 *   4. Outside the 24h window — Meta only permits template messages there, so
 *                               the send switches to the approved template for
 *                               this key, or is refused if there is none.
 *   5. Plan allowance spent   — outbound pauses; inbound is unaffected.
 *
 * Delivery itself is the outbound worker's job, using the owning tenant's own
 * WhatsApp credentials.
 */
async function deliver(
  context: NotificationContext,
  key: TemplateKey,
  variables: Record<string, string>,
  options: { idempotencyKey?: string } = {},
): Promise<void> {
  const values = {
    name: getCustomerFirstName(context.customerName) || 'there',
    business: context.businessName,
    ...variables,
  };

  const text = renderTemplate(context.templateConfig, key, values);
  const fallback = resolveTemplateFallback(key, values);

  await deliverText(context, text, {
    templateKey: key,
    ...(fallback ? { templateFallback: fallback } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
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
    const outcome = await enqueueOutboundMessage(
      {
        businessId: context.businessId,
        customerId: context.customerId,
        to: context.customerWaNumber,
        body: text,
        // The template rides along only when the window has closed. Inside it,
        // free-form text carries the owner's own wording, which an approved
        // template cannot.
        ...(decision.channel === 'template' && options.templateFallback
          ? { template: options.templateFallback }
          : {}),
        ...(options.templateKey ? { templateKey: options.templateKey } : {}),
        ...(context.relatedOrderId ? { relatedOrderId: context.relatedOrderId } : {}),
        // Automated sends abort if the owner starts replying by hand between now
        // and delivery. Human-initiated sends deliberately carry no such guard.
        ...(options.humanInitiated
          ? {}
          : { suppressIfOwnerRepliedSince: new Date().toISOString() }),
      },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {},
    );

    if (!outcome.queued) {
      // Not an error, but not nothing either: the caller asked for a send and
      // did not get one. Logged so a suppression is never invisible.
      logger.info(
        {
          businessId: context.businessId,
          customerId: context.customerId,
          template: options.templateKey,
          idempotencyKey: options.idempotencyKey,
        },
        'Customer message not queued: this event is already on the outbound queue',
      );
    }
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
  messageId: string,
): Promise<void> {
  const context = await loadNotificationContext(businessId, customerId);
  if (!context) return;

  // One courtesy reply per inbound message, forever — there is no reading of
  // this system in which the same message deserves two. That makes the message
  // id a safe idempotency key, and it is the second line of defence behind the
  // intent worker's own guard: if the worker is ever retried past that guard,
  // the queue still refuses the duplicate rather than sending it.
  await deliver(context, key, {}, { idempotencyKey: `intent-reply-${messageId}` });
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
