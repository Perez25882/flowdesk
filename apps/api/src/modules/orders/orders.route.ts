import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { assignedStaffScope, requireCapability } from '../../middleware/role.middleware.js';
import { success, created, paginated } from '../../utils/response.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
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
  app.get(
    '/orders',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListOrdersQuerySchema.parse(request.query);
    const businessId = request.business!.id;

    // A rider sees only their own deliveries. Their own staff id overrides any
    // `staffId` in the query, so passing someone else's does not widen the view.
    const scopedStaffId = assignedStaffScope(request);

    const filters = {
      status: query.status,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      staffId: scopedStaffId ?? query.staffId,
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
    },
  );

  app.get(
    '/orders/stats',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
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
    },
  );

  app.get(
    '/orders/:id',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const businessId = request.business!.id;

      const order = await findOrderById(id, businessId);

      if (!order) {
        throw new NotFoundError('Order not found');
      }

      // Riders may only open their own deliveries. Reported as 404 rather than
      // 403 so the endpoint does not confirm that an order id exists.
      const scopedStaffId = assignedStaffScope(request);

      if (scopedStaffId && order.assignedStaffId !== scopedStaffId) {
        throw new NotFoundError('Order not found');
      }

      return success(reply, order);
    },
  );

  app.post(
    '/orders',
    { preHandler: requireCapability('orders.create') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateOrderSchema.parse(request.body);
      const businessId = request.business!.id;

      const order = await createManualOrder(body, businessId);
      return created(reply, order);
    },
  );

  app.patch(
    '/orders/:id/status',
    { preHandler: requireCapability('orders.transition') },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = UpdateOrderStatusSchema.parse(request.body);
    const businessId = request.business!.id;
    // Null for the owner: there is no staff row for the account holder, and the
    // audit/assignment columns are real foreign keys.
    const changedBy = request.user?.staffId ?? null;

    // A rider can only move an order that is actually theirs.
    const scopedStaffId = assignedStaffScope(request);

    if (scopedStaffId) {
      const existing = await findOrderById(id, businessId);

      if (!existing || existing.assignedStaffId !== scopedStaffId) {
        throw new NotFoundError('Order not found');
      }

      // Riders complete deliveries. Confirming and cancelling are commercial
      // decisions that stay with the shop.
      if (body.status !== 'FULFILLED') {
        throw new ForbiddenError('You can only mark your deliveries as fulfilled');
      }
    }

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
        // The schema guarantees a note is present for this status.
        order = await cancelOrder(id, businessId, body.note!, changedBy);
        break;
      default:
        return reply.status(400).send({ success: false, error: 'Invalid status transition', code: 'INVALID_STATUS' });
    }

      return success(reply, order);
    },
  );

  app.patch(
    '/orders/:id/assign',
    { preHandler: requireCapability('orders.assign') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = AssignOrderSchema.parse(request.body);
      const businessId = request.business!.id;

      const order = await assignOrderToStaff(id, body.staffId, businessId);
      return success(reply, order);
    },
  );
}
