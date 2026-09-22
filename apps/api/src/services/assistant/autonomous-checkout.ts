import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { createPaymentLink } from '../../modules/payments/payment-links.service.js';
import { findOpenRequestForOrder } from '../../modules/payments/payment-links.repository.js';
import { autonomyDisclosureFor } from './disclosure.js';

/**
 * Closing the sale without anyone approving it.
 *
 * Only reached in AUTONOMOUS mode. The assistant has already taken the order
 * and confirmed it; this sends the customer a link for the balance, so the
 * whole exchange — question, order, payment — completes without the owner
 * touching their phone.
 *
 * Three things this deliberately does not do.
 *
 * It does not invent an amount. The link is for the order's own outstanding
 * balance, computed from rows that exist. Whatever the model said in the
 * conversation, the charge comes from the order.
 *
 * It does not send a second link when one is already out. `createPaymentLink`
 * reuses an open request for the same order and amount, which is what stops a
 * customer who says "ok" twice from receiving two live URLs for one debt and
 * paying both.
 *
 * And it never throws. The order exists and has been confirmed to the customer;
 * a failure to send a payment link must not undo that or retry the order. The
 * owner sees an unpaid order, which is a normal thing to see.
 */
export async function requestPaymentForOrder(
  businessId: string,
  customerId: string,
  orderId: string,
): Promise<boolean> {
  try {
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId },
      select: { totalAmount: true, amountPaid: true, referenceNumber: true },
    });

    if (!order) return false;

    const outstanding = Number(order.totalAmount) - Number(order.amountPaid);

    // Nothing owed, nothing to ask for. Also covers an order the assistant
    // priced at zero, where a payment link would be a charge for nothing.
    if (outstanding <= 0) return false;

    // Reaching here means AUTONOMOUS mode: nobody read this before it went to
    // a stranger. This is the message the disclosure exists for — an AI asking
    // a person for money under the shop's verified identity — and until now it
    // was the one customer-facing message that never carried it, because
    // `settlePendingOrder` returns before the reply branch that appends it.
    //
    // The order confirmation that precedes this one is a Meta-approved template
    // and cannot carry appended text, so this is the only place in the settle
    // path where the line can be said at all.
    //
    // Failing to ask must not cost the sale: the order already exists, and a
    // link that never goes out is money the shop does not collect.
    const disclosure = await autonomyDisclosureFor('AUTONOMOUS', businessId, customerId).catch(
      (error: unknown) => {
        logger.error({ error, businessId, customerId }, 'Could not check the automation disclosure');
        return null;
      },
    );

    const link = await createPaymentLink(
      businessId,
      {
        customerId,
        orderId,
        amount: outstanding,
        send: true,
        message: [
          `Here's the link to pay for ${order.referenceNumber} — GHS ${outstanding.toFixed(2)}. ` +
            'MTN MoMo, Telecel Cash, AirtelTigo Money or card.',
          disclosure ?? '',
        ]
          .filter((part) => part.length > 0)
          .join('\n'),
      },
      // No staff member raised this. Recorded as null rather than attributed to
      // the owner, because the audit trail should not say a person did
      // something a machine did.
      null,
    );

    logger.info(
      { businessId, orderId, reference: link.reference, amount: outstanding },
      'Assistant sent a payment link without approval (autonomous mode)',
    );
    return true;
  } catch (error: unknown) {
    // The commonest cause is payouts not being connected, which is a setup gap
    // rather than a fault: the order stands and the owner can collect however
    // they already do.
    logger.warn(
      { error, businessId, orderId },
      'Autonomous payment link could not be sent — the order stands unpaid',
    );
    return false;
  }
}

/**
 * The customer asked to pay. Send the link for what they owe, if they owe.
 *
 * `requestPaymentForOrder` above runs only when an order is CREATED. That left
 * no path at all for the commonest case — a customer who ordered earlier and
 * now says "how do I pay?". In testing the assistant discussed payment methods
 * across four turns and finished with "just wait for the link to pop up here in
 * the chat", for a link nothing could ever raise. A promise the system cannot
 * keep is worse than a refusal, so the caller uses the return value to decide
 * what it may truthfully say:
 *
 *   true   a link is on its way, or one was already sent and is still valid
 *   false  there is nothing to pay for, or the link could not be raised
 *
 * An open link is not raised a second time. A customer who asks twice and
 * receives two links pays one of them, and the shop then chases the other.
 */
export async function requestPaymentForOpenOrder(
  businessId: string,
  customerId: string,
): Promise<boolean> {
  try {
    // The most recent order still owed on. Cancelled orders are not owed, and
    // an old settled order is not what "how do I pay" is asking about.
    const order = await prisma.order.findFirst({
      where: { businessId, customerId, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, referenceNumber: true, totalAmount: true, amountPaid: true },
    });

    if (!order) return false;

    const outstanding = Number(order.totalAmount) - Number(order.amountPaid);
    if (outstanding <= 0) return false;

    const open = await findOpenRequestForOrder(businessId, order.id, outstanding);
    if (open) {
      logger.info(
        { businessId, orderId: order.id, reference: open.reference },
        'Customer asked to pay; a link for this order is already open',
      );
      return true;
    }

    return await requestPaymentForOrder(businessId, customerId, order.id);
  } catch (error: unknown) {
    logger.warn(
      { error, businessId, customerId },
      'Could not raise a payment link for the customer on request',
    );
    return false;
  }
}
