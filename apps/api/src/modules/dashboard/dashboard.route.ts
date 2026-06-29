import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  app.get('/dashboard/badges', async (request: FastifyRequest, reply: FastifyReply) => {
    const businessId = request.business!.id;

    const [pendingOrders, reviewMessages, lowStockCount] = await Promise.all([
      prisma.order.count({
        where: { businessId, status: 'PENDING', deletedAt: null },
      }),
      prisma.message.count({
        where: { businessId, requiresReview: true },
      }),
      // Broadly: low-stock = stockQuantity <= reorderThreshold (and threshold > 0)
      prisma.product.findMany({
        where: { businessId, active: true, deletedAt: null, reorderThreshold: { gt: 0 } },
        select: { stockQuantity: true, reorderThreshold: true },
      }).then((rows) => rows.filter((r) => Number(r.stockQuantity) <= Number(r.reorderThreshold)).length),
    ]);

    const badges: DashboardBadges = { pendingOrders, reviewMessages, lowStockProducts: lowStockCount };
    return success(reply, badges);
  });
}
