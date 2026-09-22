import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { createPaymentLink } from '../../modules/payments/payment-links.service.js';
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
): Promise<void> {
  try {
    const order = await prisma.order.findFirst({
      where: { id: orderId, businessId },
      select: { totalAmount: true, amountPaid: true, referenceNumber: true },
    });

    if (!order) return;

    const outstanding = Number(order.totalAmount) - Number(order.amountPaid);

    // Nothing owed, nothing to ask for. Also covers an order the assistant
    // priced at zero, where a payment link would be a charge for nothing.
    if (outstanding <= 0) return;

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
  } catch (error: unknown) {
    // The commonest cause is payouts not being connected, which is a setup gap
    // rather than a fault: the order stands and the owner can collect however
    // they already do.
    logger.warn(
      { error, businessId, orderId },
      'Autonomous payment link could not be sent — the order stands unpaid',
    );
  }
}
