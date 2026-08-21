import type { AssistantAction, AssistantDecision, IntentType } from '@flowdesk/shared';
import type { PendingOrder, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import {
  createOrderFromAssistant,
  type AssistantOrderItem,
} from '../../modules/orders/orders.service.js';
import {
  requestAssistantDecision,
  type AssistantResult,
} from '../intent/assistant-client.js';
import {
  deliverText,
  evaluateDelivery,
  loadNotificationContext,
  notifyOrderStatus,
  type NotificationContext,
} from '../notifications/customer-notifications.js';
import { extractItemsFromText } from '../../utils/item-extractor.js';
import { loadAssistantContext, type LoadedContext } from './context-builder.js';
import {
  abandonPendingOrder,
  attachResolvedOrder,
  claimForConversion,
  findOpenPendingOrder,
  recordClarification,
  releaseClaim,
  withConversationLock,
} from './pending-order.js';
import { routeDecision, type RouteResult } from './router.js';

/**
 * One inbound message, end to end.
 *
 * Retrieve → ask the model → check → route → record → send. Everything
 * interesting lives in the pieces this calls; the value here is the order, and
 * one rule about it: **the message row is written before anything is sent.**
 *
 * If the row were written afterwards, a crash between sending and recording
 * would leave a customer holding a reply the dashboard has no record of, and the
 * owner answering a question that has already been answered.
 */

export interface RunAssistantInput {
  businessId: string;
  customerId: string;
  messageId: string;
  body: string;
  /** The rule engine's read, used when the assistant produces nothing. */
  ruleIntent: IntentType;
  ruleConfidence: number;
  /** Escalation the server decided on its own — never overridden by the model. */
  serverEscalation?: boolean;
}

export interface RunAssistantResult {
  action: AssistantAction;
  escalated: boolean;
  /** The assistant's own read, when it produced one. Null means fall back to the rules. */
  intent: IntentType | null;
  confidence: number | null;
}

/** What the message row records when the assistant did not run at all. */
const NOT_RUN: RunAssistantResult = {
  action: 'template_reply',
  escalated: false,
  intent: null,
  confidence: null,
};

/**
 * Runs the assistant for one message, holding the conversation lock.
 *
 * The lock covers read-decide-write as one unit. Two messages arriving three
 * seconds apart is the ordinary case on WhatsApp, and without it both would read
 * "no pending order", both would open one, and the customer would be asked the
 * same question twice.
 *
 * A caller that cannot take the lock gets `NOT_RUN` and the message falls to the
 * template — better than answering against state another worker is mid-way
 * through changing.
 */
export async function runAssistant(input: RunAssistantInput): Promise<RunAssistantResult> {
  const result = await withConversationLock(input.businessId, input.customerId, () =>
    runAssistantLocked(input),
  );

  if (result === null) {
    logger.info(
      { messageId: input.messageId },
      'Another message for this conversation is in flight — skipping the assistant',
    );
    return NOT_RUN;
  }

  return result;
}

async function runAssistantLocked(input: RunAssistantInput): Promise<RunAssistantResult> {
  // Read inside the lock: it decides both what the prompt says and whether this
  // message is an answer to a question we already asked.
  const pending = await findOpenPendingOrder(input.businessId, input.customerId);

  const context = await loadAssistantContext({
    businessId: input.businessId,
    customerId: input.customerId,
    messageId: input.messageId,
    message: input.body,
    awaitingClarification: pending?.lastQuestion ?? null,
  });

  if (!context) return NOT_RUN;

  if (context.business.aiAssistMode === 'OFF') {
    return { ...NOT_RUN, escalated: input.serverEscalation ?? false };
  }

  const notification = await loadNotificationContext(input.businessId, input.customerId);
  if (!notification) return NOT_RUN;

  // Asked before generating, so the router can refuse to promise something the
  // send path would then drop. Re-checked at send time by `deliverText`.
  const delivery = await evaluateDelivery(notification);

  const result = await requestAssistantDecision({
    systemPrompt: context.systemPrompt,
    userPrompt: context.userPrompt,
    evidence: context.evidence,
  });

  if (!result.ok) {
    logger.warn(
      { messageId: input.messageId, reason: result.reason },
      'Assistant produced no decision — falling back',
    );
  }

  const decision = result.ok ? result.decision : null;

  const route = routeDecision({
    mode: context.business.aiAssistMode,
    decision,
    evidence: context.evidence,
    products: context.products,
    profile: context.profile,
    serverEscalation: input.serverEscalation ?? false,
    clarificationCount: pending?.clarificationCount ?? 0,
    canDeliver: delivery.allowed,
    catalogueMode: context.business.catalogueMode,
    message: input.body,
  });

  await recordAssistantReply(input.messageId, route, decision, result);

  const orderOutcome = await settlePendingOrder({
    input,
    decision,
    route,
    context,
    pending,
    notification,
  });

  if (orderOutcome) return orderOutcome;

  if (route.action === 'auto_send' || route.action === 'clarify') {
    const sent = await deliverText(notification, route.text ?? '');

    if (!sent.allowed) {
      // The gate moved between the two checks. The text is already stored, so
      // demote it to a draft rather than losing it.
      logger.warn(
        { messageId: input.messageId, reason: sent.reason },
        'Assistant reply blocked at send time — demoted to a draft',
      );

      await prisma.message
        .update({
          where: { id: input.messageId },
          data: { aiReplyStatus: 'DRAFT', requiresReview: true },
        })
        .catch((error: unknown) => {
          logger.error({ error, messageId: input.messageId }, 'Failed to demote assistant reply');
        });

      return {
        action: 'draft',
        escalated: route.escalated,
        intent: decision?.intent ?? null,
        confidence: decision?.confidence ?? null,
      };
    }
  }

  return {
    action: route.action,
    escalated: route.escalated,
    intent: decision?.intent ?? null,
    confidence: decision?.confidence ?? null,
  };
}

interface SettleInput {
  input: RunAssistantInput;
  decision: AssistantDecision | null;
  route: RouteResult;
  context: LoadedContext;
  pending: PendingOrder | null;
  notification: NotificationContext;
}

/**
 * Advances the order this conversation is about, if it is about one.
 *
 * Returns a result only when it has taken over the outcome — creating the order
 * and confirming it. Otherwise it does its bookkeeping and returns null so the
 * normal send path continues.
 */
async function settlePendingOrder(args: SettleInput): Promise<RunAssistantResult | null> {
  const { input, decision, route, context, pending } = args;
  if (!decision) return null;

  // Asked a question: remember it, so the next message is read as its answer
  // rather than as a fresh conversation.
  if (route.action === 'clarify' && route.text) {
    await recordClarification({
      businessId: input.businessId,
      customerId: input.customerId,
      messageId: input.messageId,
      question: route.text,
      missing: decision.clarification.missing,
      draftItems: decision.entities.products,
      existing: pending,
    });
    return null;
  }

  // The customer moved on. Left open, the draft would swallow an unrelated
  // message later as though it answered a question about something else.
  if (pending && !decision.order.isOrder) {
    await abandonPendingOrder(pending.id);
    return null;
  }

  const orderShaped = decision.order.isOrder || decision.intent === 'ORDER';
  if (!orderShaped) return null;

  const items = decision.order.complete
    ? resolveOrderItems(decision, context)
    : // The model did not call it complete, but it may still be. An answer to
      // a question we asked ("2 bags of the 5kg") is the whole order once the
      // question is taken into account, and an 8B model reports that
      // inconsistently. A held order that never converts is a lost sale, so the
      // server reads the reply itself before giving up on it.
      completeFromReply(input.body, context, pending);

  // "Complete" without anything priceable is the model being optimistic. Fall
  // through and let this become a draft rather than creating an empty order.
  if (items.length === 0) return null;

  // Claim first, create second. A retried job that has already created the
  // order loses the claim and stops here, so the customer is never charged
  // twice or confirmed twice for one order.
  if (pending && !(await claimForConversion(pending.id))) {
    logger.info(
      { pendingOrderId: pending.id },
      'Pending order already being converted — skipping',
    );
    return null;
  }

  try {
    const order = await createOrderFromAssistant(
      input.businessId,
      input.customerId,
      items,
      input.body,
    );

    if (pending) await attachResolvedOrder(pending.id, order.id);

    await prisma.message
      .update({ where: { id: input.messageId }, data: { relatedOrderId: order.id } })
      .catch(() => {
        // Cosmetic linkage; the order exists either way.
      });

    // Exactly one confirmation per order — the same contract the legacy path
    // keeps by having `createOrderFromAssistant` not reply for itself.
    await notifyOrderStatus(order.id, 'PENDING');

    return {
      action: 'auto_send',
      escalated: route.escalated,
      intent: decision.intent,
      confidence: decision.confidence,
    };
  } catch (error: unknown) {
    logger.error(
      { error, messageId: input.messageId },
      'Failed to create the order the assistant settled',
    );

    // Put it back so the conversation is not stranded mid-order.
    if (pending) await releaseClaim(pending.id);
    return null;
  }
}

/**
 * Reads a reply to a question we asked as the completion of a held order.
 *
 * Only ever runs when a pending order is open, so it cannot turn a passing
 * remark into an order — there has to be a question outstanding for a bare
 * "2 bags of the 5kg" to mean anything at all.
 *
 * Reuses the deterministic extractor rather than asking the model again: it is
 * already tested, it resolves against the same catalogue rows, and being
 * deterministic it gives the same answer on a retry.
 */
function completeFromReply(
  body: string,
  context: LoadedContext,
  pending: PendingOrder | null,
): AssistantOrderItem[] {
  if (!pending) return [];

  const extracted = extractItemsFromText(
    body,
    // Scoped to what this conversation was about, so a stray word cannot pull in
    // an unrelated product and bill the customer for it.
    context.products.map((product) => ({
      id: product.id,
      name: product.name,
      aliases: [],
      unit: product.unit,
      price: product.price,
    })),
  );

  const matched = extracted.filter((item) => item.matched && item.productId !== null);

  // Exactly one, or we are guessing. Two matches on a one-line reply means the
  // reply was ambiguous, which is a question, not an order.
  if (matched.length !== 1) return [];

  const item = matched[0]!;
  const product = context.products.find((p) => p.id === item.productId);
  if (!product) return [];

  return [
    {
      productId: product.id,
      description: product.name,
      quantity: item.quantity > 0 ? item.quantity : 1,
      unitPrice: product.price,
    },
  ];
}

/**
 * Turns the decision's product mentions into priced order lines.
 *
 * Prices come from the rows the server retrieved, never from the model — the
 * same rule as the validator, for the same reason. A mention that resolves to no
 * catalogue row is dropped rather than guessed at.
 */
export function resolveOrderItems(
  decision: AssistantDecision,
  context: Pick<LoadedContext, 'products'>,
): AssistantOrderItem[] {
  const byId = new Map(context.products.map((product) => [product.id, product]));
  const items: AssistantOrderItem[] = [];

  for (const mention of decision.entities.products) {
    if (!mention.productId) continue;

    const product = byId.get(mention.productId);
    if (!product) continue;

    items.push({
      productId: product.id,
      description: product.name,
      quantity: mention.quantity && mention.quantity > 0 ? mention.quantity : 1,
      unitPrice: product.price,
    });
  }

  return items;
}

async function recordAssistantReply(
  messageId: string,
  route: RouteResult,
  decision: AssistantDecision | null,
  result: AssistantResult,
): Promise<void> {
  if (!route.text && !decision) return;

  const status =
    route.action === 'auto_send' || route.action === 'clarify' ? 'AUTO_SENT' : 'DRAFT';

  // Built with conditional spreads rather than explicit `undefined`, which
  // `exactOptionalPropertyTypes` rejects — and which Prisma would read as
  // "leave unchanged" anyway, hiding the difference between the two.
  const data: Prisma.MessageUncheckedUpdateInput = {
    aiReplyText: route.text,
    aiReplyStatus: route.text ? status : null,
    aiReplyGroundedOn: route.groundedOn,
    aiValidationFailed: route.validationFailures,
    // Audit and offline evaluation only — never read back at runtime.
    ...(decision ? { aiDecision: decision as unknown as Prisma.InputJsonValue } : {}),
    ...(result.ok ? { aiReplyModel: result.usage.model } : {}),
    ...(decision ? { aiDetectedLanguage: decision.language } : {}),
  };

  try {
    await prisma.message.update({ where: { id: messageId }, data });
  } catch (error: unknown) {
    // Recording is not worth failing the job over; the reply itself still went
    // through the gates. Logged loudly because it breaks the audit trail.
    logger.error({ error, messageId }, 'Failed to record the assistant reply');
  }
}
