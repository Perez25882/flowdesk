import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireCapability } from '../../middleware/role.middleware.js';
import { created, success } from '../../utils/response.js';
import { CreatePaymentSchema, ListPaymentsQuerySchema, VoidPaymentSchema } from './payments.schema.js';
import type { ListPaymentsQueryInput } from './payments.schema.js';
import * as service from './payments.service.js';

/**
 * Payment routes.
 *
 * Recording money and attesting to it are separate capabilities on purpose:
 * counter staff log what they take, and only a manager or the owner attests that
 * it landed or voids a record. Without that split any staff account could both
 * fabricate attested money and later erase the evidence of it.
 *
 * There is no delete. A payment is voided, with a reason, and the row survives.
 */
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/payments',
    { preHandler: requireCapability('payments.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = CreatePaymentSchema.parse(request.body);

      // `attested` is not the caller's to assert unless they could attest a
      // payment outright. Staff without that capability record a claim for
      // review instead, whatever the request body said.
      const canAttest = request.user?.staffId === undefined || request.user?.role === 'MANAGER';

      const payment = await service.logPayment(
        { ...data, attested: canAttest ? data.attested : false },
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
    '/payments/:id/attest',
    { preHandler: requireCapability('payments.verify') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const payment = await service.attestPayment(
        id,
        request.business!.id,
        request.user?.staffId ?? 'owner',
      );
      return success(reply, payment);
    },
  );

  app.post(
    '/payments/:id/void',
    { preHandler: requireCapability('payments.void') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { reason } = VoidPaymentSchema.parse(request.body);
      await service.voidPayment(
        id,
        request.business!.id,
        request.user?.staffId ?? 'owner',
        reason,
      );
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
