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
import {
  routeDecision,
  type AuthorisedBooking,
  type AuthorisedPriceOffer,
  type RouteResult,
} from './router.js';
import { book } from '../../modules/bookings/bookings.service.js';
import { beginDeliveryCapture, handleDeliveryReply } from './delivery-flow.js';
import { autonomyDisclosureFor } from './disclosure.js';
import { requestPaymentForOpenOrder } from './autonomous-checkout.js';

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
  /**
   * What to send the customer while a draft waits on the owner. Null falls the
   * worker back to the courtesy template.
   */
  holdingText: string | null;
}

/** What the message row records when the assistant did not run at all. */
const NOT_RUN: RunAssistantResult = {
  action: 'template_reply',
  escalated: false,
  intent: null,
  confidence: null,
  holdingText: null,
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

  // Before the model, not after.
  //
  // When we have just asked this customer for a delivery address, their next
  // message is the answer to that question and nothing else. Letting the model
  // see it first means "12 Oxford Street" gets read as a fresh enquiry, or
  // worse, as a product nobody sells. The server asked; the server reads the
  // reply. This is the same boundary `clarify.ts` draws and it is drawn for
  // the same reason.
  const deliveryTurn = await handleDeliveryReply({
    businessId: input.businessId,
    customerId: input.customerId,
    body: input.body,
    notification,
    profile: context.profile,
    autonomous: context.business.aiAssistMode === 'AUTONOMOUS',
  });

  if (deliveryTurn.kind !== 'idle') {
    return {
      action: deliveryTurn.kind === 'abandoned' ? 'draft' : 'auto_send',
      // Giving up on the address is exactly when a person needs to know.
      escalated: deliveryTurn.kind === 'abandoned' || (input.serverEscalation ?? false),
      // The model never ran on this turn, so we have no read of our own. Null
      // makes the message row fall back to the rule engine's intent.
      intent: null,
      confidence: null,
      holdingText: null,
    };
  }

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

  // Take the slot BEFORE anything says it is taken, and before the order path
  // can return. The reply reads "you're booked"; if the write loses the race
  // for that time, sending it anyway would confirm an appointment that does not
  // exist, and the owner would find out when two people arrived for one slot.
  //
  // Ahead of `settlePendingOrder` rather than after it, because that function
  // returns early once an order settles — a shop selling both a product and a
  // service in the same message would otherwise confirm the appointment and
  // write nothing, which is the exact defect this guards.
  //
  // A lost race holds the whole turn for the owner. That is heavier than
  // failing the booking alone, and deliberately so: the customer asked for one
  // thing, and answering half of it automatically is worse than answering none
  // of it and saying so.
  if (
    (route.action === 'auto_send' || route.action === 'clarify') &&
    !(await settleBooking(route.authorisedBooking, input.businessId, input.customerId))
  ) {
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
      escalated: true,
      intent: decision?.intent ?? null,
      confidence: decision?.confidence ?? null,
      holdingText: route.holdingText,
    };
  }

  const orderOutcome = await settlePendingOrder({
    input,
    decision,
    route,
    context,
    pending,
    notification,
  });

  if (orderOutcome) return orderOutcome;

  // The customer asked to pay. Raise the link for what they owe, and let that
  // message BE the reply.
  //
  // Nothing did this before. A payment link was raised only at the moment an
  // order was created, so "how do I pay?" about an existing order produced four
  // turns of payment-method talk ending in "just wait for the link to pop up
  // here" — for a link nothing could ever raise.
  //
  // When the link goes out, the model's own reply is dropped rather than sent
  // alongside it. The link message already carries the amount, the order
  // reference and the disclosure, and the model's text was written without
  // knowing whether a link would exist, so it can only restate the link or
  // contradict it. When no link could be raised, the model's reply stands.
  if (
    decision?.intent === 'PAYMENT' &&
    context.business.aiAssistMode === 'AUTONOMOUS' &&
    (await requestPaymentForOpenOrder(input.businessId, input.customerId))
  ) {
    return {
      action: 'auto_send',
      escalated: false,
      intent: decision.intent,
      confidence: decision.confidence,
      holdingText: null,
    };
  }

  if (route.action === 'auto_send' || route.action === 'clarify') {
    // The link is appended here rather than being part of `route.text`,
    // because `route.text` is what gets stored as the assistant's reply and
    // what the grounding validator passed. Keeping them separate means the
    // stored draft and the sent message differ by exactly one server-controlled
    // line, which is the only difference anyone auditing this should find.
    const disclosure = await autonomyDisclosureFor(
      context.business.aiAssistMode,
      input.businessId,
      input.customerId,
    );

    const outboundText = [route.text ?? '', route.appendLink ?? '', disclosure ?? '']
      .filter((part) => part.length > 0)
      .join('\n')
      .trim();

    const sent = await deliverText(
      notification,
      outboundText,
      route.photoImageId ? { productImageId: route.photoImageId } : {},
    );

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
        holdingText: route.holdingText,
      };
    }
  }

  return {
    action: route.action,
    escalated: route.escalated,
    intent: decision?.intent ?? null,
    confidence: decision?.confidence ?? null,
    holdingText: route.holdingText,
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
  const { input, decision, route, context, pending, notification } = args;
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

  if (pending && shouldAbandonDraft(decision)) {
    await abandonPendingOrder(pending.id);
    return null;
  }

  const orderShaped = decision.order.isOrder || decision.intent === 'ORDER';
  if (!orderShaped) return null;

  // The router already decided whether the declared price was one the shop
  // authorised, and refused to auto-send the reply if it was not. Carrying that
  // same verdict here — rather than recomputing it — is what makes it
  // impossible for the message the customer reads and the order they are billed
  // for to disagree.
  const authorisedOffer = route.authorisedPriceOffer;

  const items = decision.order.complete
    ? resolveOrderItems(decision, context, authorisedOffer)
    : // The model did not call it complete, but it may still be. An answer to
      // a question we asked ("2 bags of the 5kg") is the whole order once the
      // question is taken into account, and an 8B model reports that
      // inconsistently. A held order that never converts is a lost sale, so the
      // server reads the reply itself before giving up on it.
      completeFromReply(input.body, context, pending, authorisedOffer);

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

    // Where is it going, before how will you pay.
    //
    // Asking for money first gets you a paid order nobody can fulfil, and
    // chasing the address afterwards is a second conversation with a customer
    // who considers the transaction finished. The payment link is released by
    // `delivery-flow` once there is somewhere to send the goods.
    //
    // Runs in every mode, not just AUTONOMOUS: an owner reviewing drafts still
    // needs an address on the order, and these questions are server-composed
    // templates rather than model output, so there is nothing here for a human
    // to approve.
    await beginDeliveryCapture({
      businessId: input.businessId,
      customerId: input.customerId,
      orderId: order.id,
      notification,
      profile: context.profile,
    });

    return {
      action: 'auto_send',
      escalated: route.escalated,
      intent: decision.intent,
      confidence: decision.confidence,
      // The order confirmation has already gone out; nothing is waiting on the
      // owner, so there is nothing to hold the customer with.
      holdingText: null,
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
  authorisedOffer: AuthorisedPriceOffer | null,
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
      // "Deal" is as much an acceptance of an agreed price as a full order line
      // is, so this path honours the offer for the same reason the other does.
      unitPrice: priceFor(product, authorisedOffer),
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
  authorisedOffer: AuthorisedPriceOffer | null,
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
      unitPrice: priceFor(product, authorisedOffer),
    });
  }

  return items;
}

/**
 * Whether an unanswered draft order should be thrown away on this turn.
 *
 * The draft exists because the shop asked the customer something — which size,
 * how many, which area — and is waiting for the answer. The question is whether
 * THIS message is that answer, a continuation of the same purchase, or the
 * customer starting on something else.
 *
 * This used to be `!decision.order.isOrder`, which threw the draft away on any
 * turn the model did not label an order. That lost a real sale in testing:
 *
 *   shop      Which area should we deliver to?
 *   customer  Do you deliver to Ashaiman?
 *
 * — classified INQUIRY, draft destroyed. The customer had answered the shop's
 * own question with a question, which is what people do while buying, and
 * everything after it was someone trying to pay for an order that no longer
 * existed.
 *
 * The asymmetry decides the rule. A draft wrongly KEPT costs one confusing
 * reply, and `expiresAt` clears it up shortly after. A draft wrongly ABANDONED
 * costs the sale, silently, and the owner never learns there was one. So only
 * the turns that genuinely read as a change of subject end it: a fresh greeting
 * (someone starting again) and a complaint (the order is no longer what this is
 * about). Questions, payment talk, status chases and turns the model could not
 * classify all leave the draft standing.
 */
export function shouldAbandonDraft(decision: AssistantDecision): boolean {
  return decision.intent === 'GREETING' || decision.intent === 'COMPLAINT';
}

/**
 * Takes the time the assistant just confirmed, before the confirmation is sent.
 *
 * Returns whether the slot is now genuinely held. False means the caller must
 * NOT send its reply: the text says "you're booked", and sending it after the
 * write lost would be the phantom booking this exists to prevent.
 *
 * `bookingOfferStatus` has already refused any instant outside the slots the
 * server computed, so this does not re-decide whether the time was offerable.
 * What it adds is the write — and with it the `appointments_no_overlap`
 * exclusion constraint, which is the only thing that can settle two customers
 * racing for the same slot in the same second. Until this existed, that
 * constraint was never reached from the assistant at all: the gate authorised
 * the sentence and nothing wrote the row.
 */
export async function settleBooking(
  authorised: AuthorisedBooking | null,
  businessId: string,
  customerId: string,
): Promise<boolean> {
  if (!authorised) return true;

  try {
    const appointment = await book({
      businessId,
      customerId,
      serviceId: authorised.serviceId,
      startsAt: new Date(authorised.startsAt),
      // The diary should not claim a person made this booking. `book` records
      // the distinction so the owner can see what was taken unsupervised.
      byAssistant: true,
    });

    logger.info(
      { businessId, customerId, appointmentId: appointment.id, startsAt: authorised.startsAt },
      'Assistant took an appointment without approval',
    );
    return true;
  } catch (error: unknown) {
    // Overwhelmingly the overlap constraint: someone else took it between the
    // slot being offered and the reply being composed. Not an error condition
    // for the shop — it is the guard doing its job — but the customer must be
    // told the truth, so the caller demotes the reply to a draft.
    logger.warn(
      { error, businessId, customerId, startsAt: authorised.startsAt },
      'Assistant could not take the appointment it confirmed — reply held for the owner',
    );
    return false;
  }
}

/**
 * What to charge for one line: the shelf price, or the price the shop agreed.
 *
 * The offer reaching here has already been checked against the server's own
 * ladder by `priceOfferStatus` — this function does not re-decide whether a
 * discount was allowed, it applies one that was. What it will not do is take a
 * free item on trust: a non-positive price is refused here as well as upstream,
 * because this is the function that decides what a customer actually pays.
 *
 * Without this, the floor check gated only what the assistant was allowed to
 * SAY. The order was raised at list price regardless, so a shop with bargaining
 * switched on would promise GHS 40 in writing and invoice GHS 50.
 */
function priceFor(
  product: { id: string; price: number },
  offer: AuthorisedPriceOffer | null,
): number {
  if (!offer || offer.productId !== product.id) return product.price;
  if (!Number.isFinite(offer.unitPrice) || offer.unitPrice <= 0) return product.price;

  return offer.unitPrice;
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
