import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { requireOwner } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { initializeTransaction } from '../../services/billing/paystack.js';
import { createPaystackCustomer } from '../../services/billing/paystack-customer.js';
import { comparePlans } from '../../services/plan/plan.service.js';
import { CheckoutRequestSchema, PLAN_BILLING, paystackPlanCode, type PlanKey } from './billing.schema.js';
import { recordPendingTransaction } from './pending-transaction.js';

/**
 * Initialise a Paystack transaction for the requested plan. The client is
 * redirected to `authorizationUrl` to complete payment; the `charge.success`
 * webhook flips `plan` on the business row.
 *
 * ENTERPRISE plans are intentionally not billable here — those go through
 * sales via a separate contract.
 *
 * This module is the billing plugin the authenticated sub-app registers, so it
 * also mounts the subscription-management routes below; they need exactly the
 * same auth and business context, and registering them here is what gives them
 * that.
 */
export default async function billingCheckoutRoutes(app: FastifyInstance): Promise<void> {
  await app.register((await import('./billing-subscription.route.js')).default);

  // Paying for the product is the account holder's decision alone.
  app.post('/billing/checkout', { preHandler: requireOwner }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = CheckoutRequestSchema.parse(request.body);
    const business = request.business!;
    const billing = PLAN_BILLING[body.plan as PlanKey];

    if (!billing) {
      return reply.status(400).send({ success: false, error: 'Plan not billable' });
    }

    // Settings' "Switch to this" called checkout for every tier, including
    // cheaper ones — which opened a fresh full-price transaction instead of
    // downgrading, charging a month to move DOWN a plan. A cheaper tier is a
    // downgrade and has its own endpoint, because it must take effect at the
    // end of the period already paid for rather than today.
    if (business.paystackSubCode && comparePlans(body.plan, business.plan) < 0) {
      return reply.status(409).send({
        success: false,
        error: 'That plan is cheaper than your current one. Use POST /billing/downgrade so it takes effect at the end of the period you have already paid for.',
        code: 'PLAN_DOWNGRADE_REQUIRED',
      });
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

    // Passing the plan code is what makes this a subscription rather than a
    // single payment. Without it Paystack never creates one, `paystackSubCode`
    // stays null, and a customer who has paid still reads as a lapsed trial the
    // moment their grace period runs out.
    const planCode = paystackPlanCode(body.plan);

    const callbackUrl = `${env.FRONTEND_URL ?? 'http://localhost:5173'}/settings?billing=return&plan=${body.plan}`;
    const tx = await initializeTransaction({
      email: business.email ?? `${business.id}@flowdesk.local`,
      amount: billing.amountMinor,
      ...(planCode ? { plan: planCode } : {}),
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
      ...(business.paystackSubCode ? { previousSubscriptionCode: business.paystackSubCode } : {}),
    });

    logger.info(
      { businessId: business.id, plan: body.plan, reference: tx.reference },
      'Billing checkout initialized',
    );

    return success(reply, {
      authorizationUrl: tx.authorizationUrl,
      reference: tx.reference,
      plan: body.plan,
      amountMinor: billing.amountMinor,
      // Said plainly because Paystack does not prorate and will not honour a
      // credit we invent. Moving up mid-month is a full price paid today and a
      // billing cycle that restarts today; the days left on the old plan are
      // not refunded. The UI must say so before the owner is sent to Paystack.
      immediateChargeMinor: billing.amountMinor,
      prorated: false,
      replacesSubscription: Boolean(business.paystackSubCode),
      message: `You will be charged GHS ${(billing.amountMinor / 100).toFixed(2)} today and your monthly cycle restarts from today. Days remaining on your current plan are not refunded.`,
    });
  });
}
