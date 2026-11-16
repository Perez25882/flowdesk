import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasCapability, type StaffRole } from '@flowdesk/shared';
import { assignedStaffScope, callerHasCapability, isOwner, requireCapability } from '../../middleware/role.middleware.js';
import { getProductOverview } from './overview.service.js';
import { orderActor, requireStaffMembership } from '../orders/orders.authorization.js';
import { success } from '../../utils/response.js';
import { prisma } from '../../config/database.js';
import { buildReport, reportToCsv, type ReportWindow } from './reports.service.js';
import { countConversationsNeedingYou } from '../messages/conversations.js';
import { unreadConversationCount } from '../messages/inbox-state.js';

export interface DashboardBadges {
  pendingOrders: number;
  reviewMessages: number;
  lowStockProducts: number;
  unreadConversations: number;
}

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard/overview', { preHandler: requireCapability('orders.read') }, async (request, reply) => {
    const actor = orderActor(request);
    await requireStaffMembership(prisma, actor);
    const scoped = assignedStaffScope(request);
    const operations = actor.role === 'OPERATIONS' && actor.staffId ? actor.staffId : undefined;
    const days = Number((request.query as { days?: string }).days);
    return success(reply, await getProductOverview({
      businessId: actor.businessId,
      ...(scoped ? { orderAssignee: scoped } : {}),
      ...(operations ? { visitAssignee: operations, caseAssignee: operations } : {}),
      bookings: callerHasCapability(request, 'orders.create'),
      care: callerHasCapability(request, 'messages.read'),
      revenue: callerHasCapability(request, 'revenue.read'),
      owner: isOwner(request),
    }, new Date(), [30, 60, 90].includes(days) ? days : 1));
  });
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
      const actor = orderActor(request);
      if (canReadMessages) await requireStaffMembership(prisma, actor);

      const [pendingOrders, reviewMessages, lowStockCount, unreadConversations] = await Promise.all([
        prisma.order.count({
          where: {
            businessId,
            status: 'PENDING',
            deletedAt: null,
            ...(scopedStaffId ? { assignedStaffId: scopedStaffId } : {}),
          },
        }),
        // People waiting on the owner, by the same definition the inbox uses.
        // This used to count every message ever flagged — outbound ones too,
        // answered or not — and read 39 in a shop with nobody waiting.
        canReadMessages ? countConversationsNeedingYou(businessId) : Promise.resolve(0),
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
        canReadMessages ? unreadConversationCount(actor) : Promise.resolve(0),
      ]);

      const badges: DashboardBadges = {
        pendingOrders,
        reviewMessages,
        lowStockProducts: lowStockCount,
        unreadConversations,
      };
      return success(reply, badges);
    },
  );

  /**
   * GET /reports?days=30|60|90
   *
   * `revenue.read`, because it is the takings. A staff account that may not see
   * the money may not see a chart of the money either.
   */
  app.get(
    '/reports',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireStaffMembership(prisma, orderActor(request));
      const { days } = request.query as { days?: string };
      return success(reply, await buildReport(request.business!.id, parseWindow(days)));
    },
  );

  /**
   * GET /reports/export.csv?days=30
   *
   * Served as a download rather than JSON the dashboard turns into a file, so
   * the same URL works from a phone, from an email to an accountant, and from
   * curl. The filename carries the range — a folder of files all called
   * `report.csv` helps nobody.
   */
  app.get(
    '/reports/export.csv',
    { preHandler: requireCapability('revenue.read') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireStaffMembership(prisma, orderActor(request));
      const { days } = request.query as { days?: string };
      const report = await buildReport(request.business!.id, parseWindow(days));

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="flowdesk-${report.from}-to-${report.to}.csv"`,
        )
        .send(reportToCsv(report));
    },
  );
}

/** 30, 60 or 90. Anything else is 30 rather than an error nobody can act on. */
function parseWindow(raw: string | undefined): ReportWindow {
  const value = Number(raw);
  return value === 60 || value === 90 ? value : 30;
}
