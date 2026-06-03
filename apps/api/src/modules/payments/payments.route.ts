import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { created, success } from '../../utils/response.js';
import { CreatePaymentSchema, ListPaymentsQuerySchema } from './payments.schema.js';
import type { ListPaymentsQueryInput } from './payments.schema.js';
import * as service from './payments.service.js';

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/payments', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = CreatePaymentSchema.parse(request.body);
    const payment = await service.logPayment(
      data,
      request.business!.id,
      request.user?.staffId ?? null,
    );
    return created(reply, payment);
  });

  app.get('/payments', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListPaymentsQuerySchema.parse(request.query) as ListPaymentsQueryInput;
    const payments = await service.listPayments(request.business!.id, query);
    return success(reply, payments);
  });

  app.patch('/payments/:id/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const payment = await service.verifyPayment(
      id,
      request.business!.id,
      request.user?.staffId ?? 'owner',
    );
    return success(reply, payment);
  });

  app.delete('/payments/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await service.deletePayment(id, request.business!.id);
    return reply.status(204).send();
  });

  app.get('/payments/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const stats = await service.getPaymentStats(request.business!.id);
    return success(reply, stats);
  });
}
