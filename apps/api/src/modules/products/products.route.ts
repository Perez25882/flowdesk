import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created } from '../../utils/response.js';
import { CreateProductSchema, UpdateProductSchema, StockAdjustmentSchema, ListProductsQuerySchema } from './products.schema.js';
import * as service from './products.service.js';

export default async function productRoutes(app: FastifyInstance): Promise<void> {
  app.post('/products', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = CreateProductSchema.parse(request.body);
    const product = await service.createProduct(data, request.business!.id);
    return created(reply, product);
  });

  app.get('/products', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListProductsQuerySchema.parse(request.query);
    const products = await service.listProducts(request.business!.id, query);
    return success(reply, products);
  });

  app.get('/products/low-stock', async (request: FastifyRequest, reply: FastifyReply) => {
    const products = await service.getLowStockProducts(request.business!.id);
    return success(reply, products);
  });

  app.get('/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const product = await service.findProductById(id, request.business!.id);
    if (!product) return reply.status(404).send({ success: false, error: 'Product not found', code: 'NOT_FOUND' });
    return success(reply, product);
  });

  app.patch('/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateProductSchema.parse(request.body);
    const product = await service.updateProduct(id, request.business!.id, data);
    return success(reply, product);
  });

  app.delete('/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await service.deleteProduct(id, request.business!.id);
    return reply.status(204).send();
  });

  app.post('/products/:id/stock', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = StockAdjustmentSchema.parse(request.body);
    const product = await service.adjustStock(
      id,
      request.business!.id,
      data,
      request.user?.staffId ?? null,
    );
    return success(reply, product);
  });
}
