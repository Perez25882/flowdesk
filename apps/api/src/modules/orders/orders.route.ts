import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created, paginated } from '../../utils/response.js';
import { NotFoundError } from '../../utils/errors.js';
import type { PaginationMeta } from '../../utils/response.js';
import {
  listOrders,
  findOrderById,
  assignOrderToStaff,
  getOrderStats,
  type DateRange,
} from './orders.repository.js';
import {
  createManualOrder,
  confirmOrder,
  markProcessing,
  fulfillOrder,
  cancelOrder,
} from './orders.service.js';
import {
  CreateOrderSchema,
  UpdateOrderStatusSchema,
  AssignOrderSchema,
  ListOrdersQuerySchema,
  OrderStatsQuerySchema,
} from './orders.schema.js';

export default async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListOrdersQuerySchema.parse(request.query);
    const businessId = request.business!.id;

    const filters = {
      status: query.status,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      staffId: query.staffId,
      search: query.search,
    };

    const pagination = { page: query.page, pageSize: query.pageSize };

    const { orders, total } = await listOrders(businessId, filters, pagination);

    const totalPages = Math.ceil(total / pagination.pageSize);
    const meta: PaginationMeta = {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages,
    };

    return paginated(reply, orders, meta);
  });

  app.get('/orders/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = OrderStatsQuerySchema.parse(request.query);
    const businessId = request.business!.id;

    const now = new Date();
    let dateRange: DateRange;

    if (query.period === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      dateRange = { start, end: now };
    } else if (query.period === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      dateRange = { start, end: now };
    } else if (query.period === 'month') {
      const start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      dateRange = { start, end: now };
    } else {
      dateRange = {
        start: query.dateFrom ? new Date(query.dateFrom) : new Date(now.getFullYear(), now.getMonth(), 1),
        end: query.dateTo ? new Date(query.dateTo) : now,
      };
    }

    const stats = await getOrderStats(businessId, dateRange);
    return success(reply, stats);
  });

  app.get('/orders/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const businessId = request.business!.id;

    const order = await findOrderById(id, businessId);

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    return success(reply, order);
  });

  app.post('/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = CreateOrderSchema.parse(request.body);
    const businessId = request.business!.id;

    const order = await createManualOrder(body, businessId);
    return created(reply, order);
  });

  app.patch('/orders/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = UpdateOrderStatusSchema.parse(request.body);
    const businessId = request.business!.id;
    const changedBy = request.user?.staffId ?? 'system';
    let order;

    switch (body.status) {
      case 'CONFIRMED':
        order = await confirmOrder(id, businessId, changedBy);
        break;
      case 'PROCESSING':
        order = await markProcessing(id, businessId, changedBy);
        break;
      case 'FULFILLED':
        order = await fulfillOrder(id, businessId, changedBy);
        break;
      case 'CANCELLED':
        order = await cancelOrder(id, businessId, body.note ?? 'Cancelled via API', changedBy);
        break;
      default:
        return reply.status(400).send({ success: false, error: 'Invalid status transition', code: 'INVALID_STATUS' });
    }

    return success(reply, order);
  });

  app.patch('/orders/:id/assign', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = AssignOrderSchema.parse(request.body);
    const businessId = request.business!.id;

    const order = await assignOrderToStaff(id, body.staffId, businessId);
    return success(reply, order);
  });
}
