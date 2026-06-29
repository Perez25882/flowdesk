import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { success } from '../../utils/response.js';
import { initializeTransaction } from '../../services/billing/paystack.js';
import { CheckoutRequestSchema, PLAN_BILLING, type PlanKey } from './billing.schema.js';

/**
 * Initialise a Paystack transaction for the requested plan. The client is
 * redirected to `authorizationUrl` to complete payment; the `charge.success`
 * webhook flips `plan` on the business row.
 *
 * ENTERPRISE plans are intentionally not billable here — those go through
 * sales via a separate contract.
 */
export default async function billingCheckoutRoutes(app: FastifyInstance): Promise<void> {
  app.post('/billing/checkout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = CheckoutRequestSchema.parse(request.body);
    const business = request.business!;
    const billing = PLAN_BILLING[body.plan as PlanKey];

    if (!billing) {
      return reply.status(400).send({ success: false, error: 'Plan not billable' });
    }

    let customerId = business.paystackCustomerId;
    if (!customerId) {
      const { createPaystackCustomer } = await import('../auth/auth.service.js');
      const billingEmail = business.email ?? `${business.id}@flowdesk.local`;
      customerId = await createPaystackCustomer(billingEmail, business.ownerName, business.phone ?? undefined);
      await prisma.business.update({
        where: { id: business.id },
        data: { paystackCustomerId: customerId },
      });
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
