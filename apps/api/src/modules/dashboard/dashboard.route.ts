import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasCapability, type StaffRole } from '@flowdesk/shared';
import { assignedStaffScope, isOwner, requireCapability } from '../../middleware/role.middleware.js';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';

export interface DashboardBadges {
  pendingOrders: number;
  reviewMessages: number;
  lowStockProducts: number;
}

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lightweight badge counts — used by the sidebar / bottom nav so they don't
   * need to fetch full orders/messages/products lists just to render a counter.
   * Returns just integers. React Query will cache this aggressively.
   */
  app.get(
    '/dashboard/badges',
    { preHandler: requireCapability('orders.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const businessId = request.business!.id;
      const role = isOwner(request) ? undefined : (request.user?.role as StaffRole | undefined);

      // A badge is a count of things the caller may open. Counting rows they
      // cannot read would leak how much business is going through the shop to,
      // say, a delivery rider — and tapping the badge would 403 anyway.
      const scopedStaffId = assignedStaffScope(request);
      const canReadMessages = hasCapability(role, 'messages.read');
      const canReadProducts = hasCapability(role, 'products.read');

      const [pendingOrders, reviewMessages, lowStockCount] = await Promise.all([
        prisma.order.count({
          where: {
            businessId,
            status: 'PENDING',
            deletedAt: null,
            ...(scopedStaffId ? { assignedStaffId: scopedStaffId } : {}),
          },
        }),
        canReadMessages
          ? prisma.message.count({ where: { businessId, requiresReview: true } })
          : Promise.resolve(0),
        // Broadly: low-stock = stockQuantity <= reorderThreshold (and threshold > 0)
        canReadProducts
          ? prisma.product
              .findMany({
                where: { businessId, active: true, deletedAt: null, reorderThreshold: { gt: 0 } },
                select: { stockQuantity: true, reorderThreshold: true },
              })
              .then(
                (rows) =>
                  rows.filter((r) => Number(r.stockQuantity) <= Number(r.reorderThreshold)).length,
              )
          : Promise.resolve(0),
      ]);

      const badges: DashboardBadges = {
        pendingOrders,
        reviewMessages,
        lowStockProducts: lowStockCount,
      };
      return success(reply, badges);
    },
  );
}
