import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { UpdateCustomerSchema, ListCustomersQuerySchema } from './customers.schema.js';
import * as service from './customers.service.js';

export default async function customerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/customers', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListCustomersQuerySchema.parse(request.query);
    const customers = await service.listCustomers(request.business!.id, query);
    return success(reply, customers);
  });

  app.get('/customers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const detail = await service.getCustomerDetail(id, request.business!.id);
    return success(reply, detail);
  });

  app.patch('/customers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateCustomerSchema.parse(request.body);
    const customer = await service.updateCustomer(id, request.business!.id, data);
    return success(reply, customer);
  });
}
