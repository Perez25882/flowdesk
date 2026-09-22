import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { UpdateCustomerSchema, ListCustomersQuerySchema } from './customers.schema.js';
import { requireCapability } from '../../middleware/role.middleware.js';
import * as service from './customers.service.js';
import { buildCustomerInsights } from './insights.service.js';

export default async function customerRoutes(app: FastifyInstance): Promise<void> {
  const canRead = { preHandler: requireCapability('customers.read') };

  app.get('/customers', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListCustomersQuerySchema.parse(request.query);
    const customers = await service.listCustomers(request.business!.id, query);
    return success(reply, customers);
  });

  /*
   * Deliberately registered before `/customers/:id`. Fastify's radix router
   * prefers a static segment over a parameter, so the order does not actually
   * decide it — but a reader checking "does /customers/insights get swallowed
   * by :id" should find the answer next to the code rather than in the router's
   * documentation.
   */
  app.get('/customers/insights', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, await buildCustomerInsights(request.business!.id));
  });

  app.get('/customers/:id', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const detail = await service.getCustomerDetail(id, request.business!.id);
    return success(reply, detail);
  });

  app.patch(
    '/customers/:id',
    { preHandler: requireCapability('customers.write') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const data = UpdateCustomerSchema.parse(request.body);
      const customer = await service.updateCustomer(id, request.business!.id, data);
      return success(reply, customer);
    },
  );
}
