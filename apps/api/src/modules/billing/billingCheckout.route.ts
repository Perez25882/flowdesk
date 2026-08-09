import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { requireOwner } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { initializeTransaction } from '../../services/billing/paystack.js';
import { createPaystackCustomer } from '../../services/billing/paystack-customer.js';
import { CheckoutRequestSchema, PLAN_BILLING, type PlanKey } from './billing.schema.js';
import { recordPendingTransaction } from './pending-transaction.js';

/**
 * Initialise a Paystack transaction for the requested plan. The client is
 * redirected to `authorizationUrl` to complete payment; the `charge.success`
 * webhook flips `plan` on the business row.
 *
 * ENTERPRISE plans are intentionally not billable here — those go through
 * sales via a separate contract.
 */
export default async function billingCheckoutRoutes(app: FastifyInstance): Promise<void> {
  // Paying for the product is the account holder's decision alone.
  app.post('/billing/checkout', { preHandler: requireOwner }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = CheckoutRequestSchema.parse(request.body);
    const business = request.business!;
    const billing = PLAN_BILLING[body.plan as PlanKey];

    if (!billing) {
      return reply.status(400).send({ success: false, error: 'Plan not billable' });
    }

    let customerId = business.paystackCustomerId;
    if (!customerId) {
      const billingEmail = business.email ?? `${business.id}@flowdesk.local`;
      customerId =
        (await createPaystackCustomer(
          billingEmail,
          business.ownerName,
          business.phone ?? undefined,
        )) ?? null;

      if (customerId) {
        await prisma.business.update({
          where: { id: business.id },
          data: { paystackCustomerId: customerId },
        });
      }
    }

    const callbackUrl = `${env.FRONTEND_URL ?? 'http://localhost:5173'}/settings?billing=return&plan=${body.plan}`;
    const tx = await initializeTransaction({
      email: business.email ?? `${business.id}@flowdesk.local`,
      amount: billing.amountMinor,
      callback_url: callbackUrl,
      metadata: {
        businessId: business.id,
        plan: body.plan,
        paystackCustomerId: customerId,
      },
    });

    // Record a pending transaction keyed by the reference the webhook will echo
    // back. The charge.success handler will only apply a plan change if the
    // reference matches a checkout WE initiated for THIS business at THIS price.
    // Without this, the webhook trusted metadata.businessId outright — so anyone
    // able to produce a valid signature (leaked secret, relay misconfig) could
    // upgrade or suspend any tenant. The signature stays necessary; it is no
    // longer sufficient on its own.
    await recordPendingTransaction({
      reference: tx.reference,
      businessId: business.id,
      plan: body.plan,
      expectedAmount: billing.amountMinor,
    });

    logger.info(
      { businessId: business.id, plan: body.plan, reference: tx.reference },
      'Billing checkout initialized',
    );

    return success(reply, {
      authorizationUrl: tx.authorizationUrl,
      reference: tx.reference,
    });
  });
}
