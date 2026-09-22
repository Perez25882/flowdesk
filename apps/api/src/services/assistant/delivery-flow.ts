import type { BusinessProfile } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliverText, type NotificationContext } from '../notifications/customer-notifications.js';
import { requestPaymentForOrder } from './autonomous-checkout.js';
import {
  composeConfirmation,
  composeQuestion,
  isAffirmative,
  isComplete,
  nextMissingField,
  parseAnswer,
  type DeliveryDetails,
} from './delivery-capture.js';

/**
 * The conversation that turns a confirmed order into a deliverable one.
 *
 * Sits between "order confirmed" and "here is your payment link", because
 * asking someone to pay before you know where the goods are going gets you a
 * paid order you cannot fulfil, and chasing the address afterwards is a second
 * conversation with someone who now considers the transaction finished.
 *
 * All of it runs inside the conversation lock `runAssistant` already holds, and
 * the whole state machine is derived from the order's own columns rather than
 * kept anywhere: whichever of the three fields is still null is the next
 * question. A retried job, a duplicate webhook or a customer who answers twice
 * therefore cannot desynchronise it, because there is nothing to desynchronise.
 */

/**
 * Past this many questions the customer is not going to answer, and asking
 * again is harassment rather than service. The order stays, the owner picks it
 * up in the dashboard with the details blank.
 */
const MAX_DELIVERY_ASKS = 8;

/** Orders still waiting on delivery details are only chased this long. */
const CHASE_WINDOW_HOURS = 48;

export type DeliveryTurn =
  /** Nothing was owed here; carry on with the normal assistant. */
  | { kind: 'idle' }
  /** A question went out. The message was an answer to us, not a new request. */
  | { kind: 'asked' }
  /** Details complete. The payment link has been released. */
  | { kind: 'captured' }
  /** We gave up asking. A person should look at it. */
  | { kind: 'abandoned' };

const ORDER_FIELDS = {
  id: true,
  referenceNumber: true,
  recipientName: true,
  deliveryAddress: true,
  contactPhone: true,
  deliveryCapturedAt: true,
  deliveryAsks: true,
} as const;

type AwaitingOrder = {
  id: string;
  referenceNumber: string;
  recipientName: string | null;
  deliveryAddress: string | null;
  contactPhone: string | null;
  deliveryCapturedAt: Date | null;
  deliveryAsks: number;
};

/**
 * The order this customer is currently being asked about, if any.
 *
 * Newest first and bounded by a window: an order abandoned three weeks ago must
 * not hijack today's conversation, which is exactly what would happen if the
 * only condition were "details still missing".
 */
export async function findOrderAwaitingDelivery(
  businessId: string,
  customerId: string,
): Promise<AwaitingOrder | null> {
  const since = new Date(Date.now() - CHASE_WINDOW_HOURS * 60 * 60 * 1000);

  return prisma.order.findFirst({
    where: {
      businessId,
      customerId,
      deletedAt: null,
      deliveryCapturedAt: null,
      status: { in: ['PENDING', 'CONFIRMED'] },
      createdAt: { gte: since },
      // Only orders we have actually started asking about. An order created by
      // the owner in the dashboard should not make the assistant interrogate
      // the next person who says hello.
      deliveryAsks: { gt: 0 },
    },
    orderBy: { createdAt: 'desc' },
    select: ORDER_FIELDS,
  });
}

function details(order: AwaitingOrder): DeliveryDetails {
  return {
    recipientName: order.recipientName,
    deliveryAddress: order.deliveryAddress,
    contactPhone: order.contactPhone,
  };
}

async function ask(
  orderId: string,
  asks: number,
  notification: NotificationContext,
  text: string,
): Promise<DeliveryTurn> {
  // Counter first. If the send fails we have still spent an attempt, which is
  // the conservative direction: the alternative is a send that half-succeeds
  // and a counter that lets us ask forever.
  await prisma.order.update({ where: { id: orderId }, data: { deliveryAsks: asks + 1 } });
  await deliverText(notification, text, { templateKey: 'order_confirmed' });
  return { kind: 'asked' };
}

async function abandon(orderId: string, reference: string): Promise<DeliveryTurn> {
  logger.info(
    { orderId, reference },
    'Stopped asking for delivery details after the limit; the owner takes it from here',
  );
  return { kind: 'abandoned' };
}

/**
 * Marks the details complete and releases the payment link.
 *
 * The customer's own record is updated at the same time so the next order can
 * be one message instead of three. It is written as "last known" rather than as
 * the truth, because people do not always send things to the same place.
 */
async function finish(
  businessId: string,
  customerId: string,
  order: AwaitingOrder,
  captured: DeliveryDetails,
  notification: NotificationContext,
  autonomous: boolean,
): Promise<DeliveryTurn> {
  await prisma.$transaction([
    prisma.order.update({
      where: { id: order.id },
      data: { ...captured, deliveryCapturedAt: new Date() },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        lastRecipientName: captured.recipientName,
        lastDeliveryAddress: captured.deliveryAddress,
        lastContactPhone: captured.contactPhone,
      },
    }),
  ]);

  await deliverText(
    notification,
    `Got it. ${order.referenceNumber} is going to ${captured.deliveryAddress}.`,
    { templateKey: 'order_confirmed' },
  );

  // Only now, with somewhere to send the goods, is it reasonable to ask for
  // money. Every other mode leaves the link to the owner.
  if (autonomous) {
    await requestPaymentForOrder(businessId, customerId, order.id);
  }

  return { kind: 'captured' };
}

/**
 * Opens the delivery conversation for a freshly confirmed order.
 *
 * A returning customer is shown what we already hold and asked to confirm it.
 * Everyone else gets the first missing field.
 */
export async function beginDeliveryCapture(params: {
  businessId: string;
  customerId: string;
  orderId: string;
  notification: NotificationContext;
  profile: BusinessProfile | null;
}): Promise<DeliveryTurn> {
  try {
    return await beginDeliveryCaptureUnsafe(params);
  } catch (error: unknown) {
    // Never throws, for the same reason `requestPaymentForOrder` never throws:
    // the order exists and has already been confirmed to the customer, and a
    // failure to start asking for an address must not undo that or make the
    // caller believe the order failed. The owner sees an order with the
    // delivery fields blank, which is a normal thing to see.
    //
    // This also covers the window between deploying this code and running the
    // migration, where the Prisma client does not yet know the new columns.
    logger.error({ error, orderId: params.orderId }, 'Could not start delivery capture');
    return { kind: 'idle' };
  }
}

async function beginDeliveryCaptureUnsafe(params: {
  businessId: string;
  customerId: string;
  orderId: string;
  notification: NotificationContext;
  profile: BusinessProfile | null;
}): Promise<DeliveryTurn> {
  const { businessId, customerId, orderId, notification, profile } = params;

  const [order, customer] = await Promise.all([
    prisma.order.findFirst({ where: { id: orderId, businessId }, select: ORDER_FIELDS }),
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { lastRecipientName: true, lastDeliveryAddress: true, lastContactPhone: true },
    }),
  ]);

  if (!order || order.deliveryCapturedAt) return { kind: 'idle' };

  const known: DeliveryDetails = {
    recipientName: customer?.lastRecipientName ?? null,
    deliveryAddress: customer?.lastDeliveryAddress ?? null,
    contactPhone: customer?.lastContactPhone ?? null,
  };

  if (isComplete(known)) {
    // Prefilled, but NOT marked captured: the customer still has to say yes.
    // Writing the columns now is what lets the reply handler tell "awaiting a
    // yes" from "awaiting a field" without storing a mode anywhere.
    await prisma.order.update({ where: { id: order.id }, data: known });
    return ask(order.id, order.deliveryAsks, notification, composeConfirmation(known)!);
  }

  const field = nextMissingField(details(order))!;
  return ask(order.id, order.deliveryAsks, notification, composeQuestion(field, { profile }));
}

/**
 * Handles an inbound message that is an answer to a delivery question.
 *
 * Returns `idle` when this conversation is not in that state, which is the
 * caller's signal to run the normal assistant.
 */
export async function handleDeliveryReply(params: {
  businessId: string;
  customerId: string;
  body: string;
  notification: NotificationContext;
  profile: BusinessProfile | null;
  autonomous: boolean;
}): Promise<DeliveryTurn> {
  try {
    return await handleDeliveryReplyUnsafe(params);
  } catch (error: unknown) {
    // `idle` rather than a rethrow: this runs before the model, so a failure
    // here would otherwise swallow the customer's message entirely. Falling
    // through to the normal assistant is the safe direction.
    logger.error({ error, customerId: params.customerId }, 'Delivery reply handling failed');
    return { kind: 'idle' };
  }
}

async function handleDeliveryReplyUnsafe(params: {
  businessId: string;
  customerId: string;
  body: string;
  notification: NotificationContext;
  profile: BusinessProfile | null;
  autonomous: boolean;
}): Promise<DeliveryTurn> {
  const { businessId, customerId, body, notification, profile, autonomous } = params;

  const order = await findOrderAwaitingDelivery(businessId, customerId);
  if (!order) return { kind: 'idle' };

  if (order.deliveryAsks >= MAX_DELIVERY_ASKS) {
    return abandon(order.id, order.referenceNumber);
  }

  const current = details(order);

  // Fully prefilled and not yet captured means we asked them to confirm.
  if (isComplete(current)) {
    if (isAffirmative(body)) {
      return finish(businessId, customerId, order, current, notification, autonomous);
    }

    // They said something other than yes, so at least one of the three is
    // wrong and we do not know which. Clearing all of them and starting over
    // costs two extra messages; keeping the wrong one costs a failed delivery.
    await prisma.order.update({
      where: { id: order.id },
      data: { recipientName: null, deliveryAddress: null, contactPhone: null },
    });
    return ask(order.id, order.deliveryAsks, notification, composeQuestion('recipientName', { profile }));
  }

  const field = nextMissingField(current)!;
  const value = parseAnswer(field, body);

  if (value === null) {
    return ask(
      order.id,
      order.deliveryAsks,
      notification,
      composeQuestion(field, { profile, reasked: true }),
    );
  }

  const updated: DeliveryDetails = { ...current, [field]: value };
  await prisma.order.update({ where: { id: order.id }, data: { [field]: value } });

  const remaining = nextMissingField(updated);
  if (remaining === null) {
    return finish(businessId, customerId, { ...order, ...updated }, updated, notification, autonomous);
  }

  return ask(order.id, order.deliveryAsks, notification, composeQuestion(remaining, { profile }));
}
