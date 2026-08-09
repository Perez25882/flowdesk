import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability } from '../../middleware/role.middleware.js';
import { created, success } from '../../utils/response.js';
import { CreatePaymentSchema, ListPaymentsQuerySchema } from './payments.schema.js';
import type { ListPaymentsQueryInput } from './payments.schema.js';
import * as service from './payments.service.js';

/**
 * Payment routes.
 *
 * Recording money and confirming it are separate capabilities on purpose:
 * counter staff log what they take, and only a manager or the owner marks it
 * verified or removes it. Without that split any staff account could both
 * fabricate a verified payment and later erase the record of one.
 */
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/payments',
    { preHandler: requireCapability('payments.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = CreatePaymentSchema.parse(request.body);

      // `verified` is not the caller's to assert unless they could verify a
      // payment outright. Staff without that capability stage the payment for
      // review instead, whatever the request body said.
      const canVerify = request.user?.staffId === undefined || request.user?.role === 'MANAGER';

      const payment = await service.logPayment(
        { ...data, verified: canVerify ? data.verified : false },
        request.business!.id,
        request.user?.staffId ?? null,
      );
      return created(reply, payment);
    },
  );

  app.get(
    '/payments',
    { preHandler: requireCapability('payments.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListPaymentsQuerySchema.parse(request.query) as ListPaymentsQueryInput;
      const payments = await service.listPayments(request.business!.id, query);
      return success(reply, payments);
    },
  );

  app.patch(
    '/payments/:id/verify',
    { preHandler: requireCapability('payments.verify') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const payment = await service.verifyPayment(
        id,
        request.business!.id,
        request.user?.staffId ?? 'owner',
      );
      return success(reply, payment);
    },
  );

  app.delete(
    '/payments/:id',
    { preHandler: requireCapability('payments.delete') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await service.deletePayment(id, request.business!.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/payments/stats',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await service.getPaymentStats(request.business!.id);
      return success(reply, stats);
    },
  );
}
