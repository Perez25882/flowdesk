import type { AssistantAction, AssistantDecision, IntentType } from '@flowdesk/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { createOrderFromAssistant, type AssistantOrderItem } from '../../modules/orders/orders.service.js';
import { requestAssistantDecision, type AssistantResult } from '../intent/assistant-client.js';
import { deliverText, evaluateDelivery, loadNotificationContext } from '../notifications/customer-notifications.js';
import { loadAssistantContext, type LoadedContext } from './context-builder.js';
import { abandonPendingOrder, findOpenPendingOrder, recordClarification, withConversationLock } from './pending-order.js';
import { policyHandoff, routeDecision, type AuthorisedBooking, type AuthorisedPriceOffer, type RouteInput, type RouteResult } from './router.js';
import { book } from '../../modules/bookings/bookings.service.js';
import { beginDeliveryCapture, handleDeliveryReply } from './delivery-flow.js';
import { autonomyDisclosureFor } from './disclosure.js';
import { requestPaymentForOpenOrder } from './autonomous-checkout.js';
import { hasPolicyOverride, ordinaryReply, slotLabel } from './commitment.js';
import { unitPriceForQuantity } from '../pricing/ladder.js';

export interface RunAssistantInput {
  businessId: string;
  customerId: string;
  messageId: string;
  body: string;
  ruleIntent: IntentType;
  ruleConfidence: number;
  serverEscalation?: boolean;
}

export interface RunAssistantResult {
  action: AssistantAction;
  escalated: boolean;
  intent: IntentType | null;
  confidence: number | null;
  holdingText: string | null;
  policyHandled?: boolean;
}

const NOT_RUN: RunAssistantResult = {
  action: 'template_reply', escalated: false, intent: null, confidence: null, holdingText: null,
};

export async function runAssistant(input: RunAssistantInput): Promise<RunAssistantResult> {
  const source = await prisma.message.findFirst({
    where: { id: input.messageId, businessId: input.businessId, customerId: input.customerId,
      direction: 'INBOUND', body: input.body, customer: { businessId: input.businessId, deletedAt: null, blacklisted: false } },
    select: { aiPolicy: true, business: { select: { aiAssistMode: true, autonomyAcceptedAt: true } } },
  });
  if (!source) return { ...NOT_RUN, action: 'draft', escalated: true, policyHandled: true };
  if (source.aiPolicy) return { ...NOT_RUN, action: 'none', policyHandled: true };
  if (source.business.aiAssistMode === 'OFF') return NOT_RUN;
  const result = await withConversationLock(input.businessId, input.customerId, () => runAssistantLocked(input, source.business));
  if (result) return result;
  await prisma.message.updateMany({ where: { ...scope(input), aiPolicy: { equals: Prisma.DbNull } }, data: { requiresReview: true } });
  return { ...NOT_RUN, action: 'draft', escalated: true, policyHandled: true };
}

const scope = ({ businessId, customerId, messageId }: RunAssistantInput) => ({ id: messageId, businessId, customerId });

function toResult(route: RouteResult, decision: AssistantDecision | null): RunAssistantResult {
  return {
    action: route.action, escalated: route.escalated, holdingText: route.holdingText, policyHandled: true,
    intent: decision?.intent ?? null, confidence: decision?.confidence ?? null,
  };
}

async function runAssistantLocked(
  input: RunAssistantInput,
  settings: { aiAssistMode: RouteInput['mode']; autonomyAcceptedAt: Date | null },
): Promise<RunAssistantResult> {
  const { businessId, customerId, messageId, body } = input;
  const claimed = await prisma.message.updateMany({
    where: { ...scope(input), aiPolicy: { equals: Prisma.DbNull } },
    data: { aiPolicy: { version: 1, state: 'PROCESSING', mode: settings.aiAssistMode }, requiresReview: true },
  });
  if (!claimed.count) return { ...NOT_RUN, action: 'none', policyHandled: true };

  let decision: AssistantDecision | null = null;
  let result: AssistantResult | null = null;
  let route = policyHandoff();
  let effectCommitted = false;
  const mode = settings.aiAssistMode;

  try {
    if (input.serverEscalation || hasPolicyOverride(body) || (mode === 'AUTONOMOUS' && !settings.autonomyAcceptedAt)) {
      route = policyHandoff('unverified_customer_request');
      await persistOutcome(input, route, mode, 'REVIEW');
      return toResult(route, null);
    }
    const pending = await findOpenPendingOrder(businessId, customerId);
    const contextInput = { businessId, customerId, messageId, message: body, awaitingClarification: pending?.lastQuestion ?? null };
    const context = await loadAssistantContext(contextInput);
    const notification = await loadNotificationContext(businessId, customerId);
    if (!context || !notification) throw new Error('Assistant context unavailable');
    if (context.business.aiAssistMode !== mode) throw new Error('Assistant mode changed');

    const delivery = await evaluateDelivery(notification);
    if (delivery.allowed && (mode === 'AUTONOMOUS' || mode === 'GROUNDED_AUTO') &&
        !/\b(?:order status|delivered|payment|refund|appointment|book)\b/i.test(body)) {
      const turn = await handleDeliveryReply({ businessId, customerId, body, notification, profile: context.profile, autonomous: mode === 'AUTONOMOUS' });
      if (turn.kind !== 'idle') {
        route = { ...route, action: turn.kind === 'abandoned' ? 'draft' : 'clarify', holdingText: null };
        await persistOutcome(input, route, mode, turn.kind === 'abandoned' ? 'REVIEW' : turn.kind === 'asked' ? 'WAITING_CUSTOMER' : 'COMPLETED');
        return toResult(route, null);
      }
    }

    const ordinary = ordinaryReply(body, null);
    result = ordinary ? null : await requestAssistantDecision({ systemPrompt: context.systemPrompt, userPrompt: context.userPrompt, evidence: context.evidence });
    decision = result?.ok ? result.decision : null;
    const decide = (loaded: LoadedContext, canDeliver: boolean): RouteResult => routeDecision({
      mode, decision, evidence: loaded.evidence, products: loaded.products, profile: loaded.profile,
      serverEscalation: false, clarificationCount: pending?.clarificationCount ?? 0, canDeliver,
      catalogueMode: loaded.business.catalogueMode, message: body,
    });
    route = decide(context, delivery.allowed);
    if (ordinary) {
      if (pending && shouldAbandonDraft({ intent: input.ruleIntent })) {
        await abandonPendingOrder(pending.id);
      }
      const auto = delivery.allowed && (mode === 'AUTONOMOUS' || mode === 'GROUNDED_AUTO');
      route = { ...route, action: auto ? 'auto_send' : 'draft', effect: 'reply', text: ordinary,
        escalated: false, ...(auto ? { holdingText: null } : {}) };
    }

    if (decision && (route.effect === 'reply' || route.effect === 'booking' || route.effect === 'order' || route.effect === 'clarification')) {
      const fresh = await loadAssistantContext({ ...contextInput, includeUntrustedContext: false });
      const current = fresh && fresh.business.aiAssistMode === mode ? decide(fresh, delivery.allowed) : null;
      if (!current || current.effect !== route.effect || current.text !== route.text || current.appendLink !== route.appendLink ||
          current.photoImageId !== route.photoImageId || current.action !== route.action ||
          current.groundedOn.join(',') !== route.groundedOn.join(',')) {
        route = policyHandoff('stale_evidence');
      }
    }

    if (route.action === 'draft') {
      await persistOutcome(input, route, mode, 'REVIEW', result, decision);
      return toResult(route, decision);
    }

    await persistOutcome(input, route, mode, 'PROCESSING', result, decision);

    if (route.effect === 'order') {
      if (!decision) throw new Error('Assistant order proposal missing');
      const items = resolveOrderItems(decision, context, route.authorisedPriceOffer);
      if (items.length !== decision.entities.products.length ||
          (route.authorisedPriceOffer && !items.some((item) => item.productId === route.authorisedPriceOffer?.productId && item.quantity === route.authorisedPriceOffer.quantity))) {
        throw new Error('Assistant order items do not match the proposal');
      }
      const order = await createOrderFromAssistant(businessId, customerId, items, body, {
        messageId, ...(pending ? { pendingOrderId: pending.id } : {}),
      });
      effectCommitted = true;
      route.groundedOn = [`order:${order.id}`, ...items.map((item) => `product:${item.productId}`)];
      route.text = `Order ${order.referenceNumber} was recorded for the shop to confirm. Total: GHS ${Number(order.totalAmount).toFixed(2)}.`;
    }

    if (route.effect === 'booking' && route.authorisedBooking) {
      const appointment = await settleBooking(route.authorisedBooking, businessId, customerId, messageId);
      if (!appointment) throw new Error('Assistant booking unavailable');
      effectCommitted = true;
      route.groundedOn.push(`appointment:${appointment.id}`);
      route.text = `Appointment ${appointment.reference} is booked for ${slotLabel(appointment.startsAt)}.`;
    }

    if (route.effect === 'checkout') {
      const checkout = await requestPaymentForOpenOrder(businessId, customerId, messageId);
      if (!checkout) throw new Error('Assistant checkout unavailable');
      route.groundedOn = [`order:${checkout.orderId}`, `payment_request:${checkout.requestId}`];
      await persistOutcome(input, route, mode, 'HANDED_OFF', result, decision);
      return toResult(route, decision);
    }

    if (route.effect === 'clarification') {
      const recorded = await recordClarification({ businessId, customerId, messageId,
        question: route.text!, missing: decision?.clarification.missing ?? [], draftItems: [], existing: pending });
      if (!recorded) throw new Error('Assistant clarification could not be saved');
    }

    const disclosure = await autonomyDisclosureFor(mode, businessId, customerId);
    const outbound = [route.text, route.appendLink, disclosure].filter(Boolean).join('\n');
    if (!outbound) throw new Error('No authorized customer reply');
    const currentActor = await prisma.message.findFirst({ where: { ...scope(input), body,
      customer: { businessId, deletedAt: null, blacklisted: false }, business: { active: true, deletedAt: null, deactivatedAt: null,
        aiAssistMode: mode, ...(mode === 'AUTONOMOUS' ? { autonomyAcceptedAt: { not: null } } : {}) } }, select: { id: true } });
    if (!currentActor) throw new Error('Assistant send permission changed');
    const currentNotification = await loadNotificationContext(businessId, customerId);
    if (!currentNotification) throw new Error('Assistant recipient unavailable');
    const sent = await deliverText(currentNotification, outbound, {
      idempotencyKey: `assistant-reply-${messageId}`, requireQueueHandoff: true,
      ...(route.photoImageId ? { productImageId: route.photoImageId } : {}),
    });
    if (!sent.allowed) throw new Error('Assistant reply blocked by outbound policy');
    await persistOutcome(input, route, mode, route.effect === 'clarification' ? 'WAITING_CUSTOMER' : 'HANDED_OFF', result, decision);

    if (route.effect === 'order') {
      const orderId = route.groundedOn[0]?.slice('order:'.length);
      if (orderId) await beginDeliveryCapture({ businessId, customerId, orderId, notification, profile: context.profile });
    }
    return toResult(route, decision);
  } catch (error: unknown) {
    logger.warn({ messageId, businessId, effect: route.effect, errorType: error instanceof Error ? error.name : 'Unknown' }, 'Assistant turn requires recovery');
    const failed = { ...policyHandoff(effectCommitted ? 'handoff_failed' : 'effect_unavailable'), effect: route.effect, groundedOn: route.groundedOn,
      ...(effectCommitted ? { holdingText: null } : {}) };
    await persistOutcome(input, failed, mode, effectCommitted ? 'WAITING_HANDOFF' : 'REVIEW', result, decision);
    return toResult(failed, decision);
  }
}

export function resolveOrderItems(
  decision: AssistantDecision,
  context: Pick<LoadedContext, 'products'>,
  authorisedOffer: AuthorisedPriceOffer | null,
): AssistantOrderItem[] {
  const items: AssistantOrderItem[] = [];
  for (const mention of decision.entities.products) {
    const product = context.products.find((candidate) => candidate.id === mention.productId);
    if (!product) continue;
    const quantity = mention.quantity && mention.quantity > 0 ? mention.quantity : 1;
    const unitPrice = authorisedOffer?.productId === product.id && authorisedOffer.quantity === quantity && authorisedOffer.unitPrice > 0
      ? authorisedOffer.unitPrice
      : product.ladder ? unitPriceForQuantity(product.ladder, quantity) : product.price;
    items.push({ productId: product.id, description: product.name, quantity, unitPrice });
  }
  return items;
}

export function shouldAbandonDraft(turn: Pick<AssistantDecision, 'intent'>): boolean {
  return turn.intent === 'GREETING' || turn.intent === 'COMPLAINT';
}

export async function settleBooking(
  authorised: AuthorisedBooking, businessId: string, customerId: string, messageId: string,
): Promise<Awaited<ReturnType<typeof book>> | null> {
  try {
    return await book({ businessId, customerId, serviceId: authorised.serviceId,
      startsAt: new Date(authorised.startsAt), byAssistant: true, assistantMessageId: messageId });
  } catch {
    return null;
  }
}

async function persistOutcome(input: RunAssistantInput, route: RouteResult, mode: RouteInput['mode'], state: string,
  result?: AssistantResult | null, decision?: AssistantDecision | null): Promise<void> {
  const reviewed = state === 'REVIEW' || state === 'WAITING_HANDOFF';
  const draftText = route.text && route.effect === 'reply' ? route.text : null;
  const sent = state === 'HANDED_OFF' || state === 'WAITING_CUSTOMER';
  const data: Prisma.MessageUncheckedUpdateInput = {
    aiPolicy: {
      version: 1, mode, state, effect: route.effect, reasons: route.validationFailures,
      evidence: route.groundedOn, ...(result && !result.ok ? { providerFailure: result.reason } : {}),
      ...(draftText && decision?.answer.fact ? { fact: { ...decision.answer.fact }, offer: decision.priceOffer } : {}),
    },
    aiReplyText: sent ? route.text : reviewed ? draftText : null,
    aiReplyStatus: sent && route.text ? 'AUTO_SENT' : reviewed && draftText ? 'DRAFT' : null,
    aiReplyGroundedOn: route.groundedOn, aiValidationFailed: route.validationFailures,
    requiresReview: reviewed || state === 'PROCESSING',
    ...(result?.ok ? { aiReplyModel: result.usage.model } : {}),
    ...(decision ? { aiDetectedLanguage: decision.language } : {}),
  };
  await prisma.message.update({ where: scope(input), data });
}
