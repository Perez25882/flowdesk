import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { success } from '../../utils/response.js';
import { verifyWebhookSignature } from '../../services/billing/paystack.js';

interface PaystackWebhookBody {
  event: string;
  data: {
    reference: string;
    status: string;
    amount: number;
    customer: {
      email: string;
      customer_code: string;
    };
    plan?: string;
    subscription?: {
      subscription_code: string;
      status: string;
    };
    metadata?: Record<string, unknown>;
  };
}

export default async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/paystack', async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers['x-paystack-signature'];
    if (typeof signature !== 'string') {
      return reply.status(401).send({ success: false, error: 'Missing signature' });
    }

    const rawBody = JSON.stringify(request.body);
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      logger.warn({ ip: request.ip }, 'Paystack webhook signature verification failed');
      return reply.status(401).send({ success: false, error: 'Invalid signature' });
    }

    const payload = request.body as PaystackWebhookBody;
    const { event, data } = payload;

    logger.info({ event, reference: data.reference }, 'Paystack webhook received');

    if (event === 'charge.success') {
      const businessId = data.metadata?.businessId as string | undefined;
      if (businessId) {
        await prisma.business.update({
          where: { id: businessId },
          data: {
            suspendedAt: null,
            suspendReason: null,
          },
        });
        logger.info({ businessId, reference: data.reference }, 'Business reactivated after successful payment');
      }
    }

    if (event === 'subscription.disable' || event === 'subscription.not_renew') {
      const business = await prisma.business.findFirst({
        where: {
          paystackSubCode: data.subscription?.subscription_code ?? null,
        },
      });

      if (business) {
        await prisma.business.update({
          where: { id: business.id },
          data: {
            suspendedAt: new Date(),
            suspendReason: 'Subscription cancelled or payment failed',
          },
        });
        logger.info({ businessId: business.id }, 'Business suspended due to subscription issue');
      }
    }

    return success(reply, { received: true });
  });
}
