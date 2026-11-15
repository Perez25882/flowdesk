import type { Prisma, Workflow } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireOwner } from '../../middleware/role.middleware.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { success } from '../../utils/response.js';
import { minute, presets, settingsInput, terminal } from './workflow.contract.js';
import { lockWorkflow, transition } from './workflow.store.js';

const decisionInput = z.object({ approve: z.boolean(), revision: z.number().int().min(0) }).strict();
const commandInput = z.object({ revision: z.number().int().min(0) }).strict();
const idInput = z.object({ id: z.string().uuid() });
const canRetryReasons = new Set([
  'DEPENDENCY_DEADLINE_EXPIRED', 'OUTBOUND_REQUIRES_REVIEW', 'FULFILLMENT_NOTICE_BLOCKED',
]);

async function activeOwner(tx: Prisma.TransactionClient, businessId: string): Promise<void> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM businesses WHERE id = ${businessId} AND active AND "deletedAt" IS NULL
      AND "deactivatedAt" IS NULL AND "suspendedAt" IS NULL FOR SHARE
  `;
  if (!locked) throw new ForbiddenError('Business is unavailable');
}

function actions(row: Workflow) {
  return {
    approve: row.state === 'WAITING_OWNER_APPROVAL',
    cancel: row.state === 'WAITING_OWNER_APPROVAL' || row.reason === 'OWNER_APPROVED',
    escalate: !row.sendId && !terminal.has(row.state) && row.state !== 'REVIEW_REQUIRED' &&
      row.state !== 'WAITING_OWNER_APPROVAL' && row.reason !== 'OWNER_APPROVED',
    retry: row.state === 'REVIEW_REQUIRED' && canRetryReasons.has(row.reason) && row.recoveryCount < 3 &&
      Boolean(row.sendId || row.orderId || row.appointmentId),
  };
}

async function inspect(
  tx: Prisma.TransactionClient, businessId: string, id: string, revision: number,
): Promise<Workflow> {
  const row = await lockWorkflow(tx, businessId, id);
  await activeOwner(tx, businessId);
  if (row.revision !== revision || terminal.has(row.state)) throw new ConflictError('Refresh this workflow before changing it');
  return row;
}

export default async function workflowRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner };

  app.get('/workflows', owner, async (request, reply) => {
    const { state, before } = z.object({
      state: z.enum(['CREATED', 'READY', 'RUNNING', 'WAITING_CUSTOMER', 'WAITING_OWNER_APPROVAL', 'WAITING_STAFF',
        'WAITING_PROVIDER', 'RETRY_SCHEDULED', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
      before: z.string().datetime().optional(),
    }).strict().parse(request.query);
    const rows = await prisma.workflow.findMany({
      where: { businessId: request.business!.id, ...(state ? { state } : {}),
        ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
      include: { customer: { select: { name: true } } },
    });
    return success(reply, rows.map((row) => ({ ...row, actions: actions(row) })));
  });

  app.get('/workflows/:id', owner, async (request, reply) => {
    const { id } = idInput.parse(request.params);
    const row = await prisma.workflow.findUnique({
      where: { id_businessId: { id, businessId: request.business!.id } },
      include: { approval: true, evidence: { orderBy: { id: 'desc' }, take: 100 }, customer: { select: { name: true } } },
    });
    if (!row) throw new NotFoundError('Workflow not found');
    const order = row.orderId ? await prisma.order.findFirst({ where: {
      id: row.orderId, businessId: row.businessId, customerId: row.customerId, deletedAt: null,
    }, select: { referenceNumber: true } }) : null;
    return success(reply, { ...row, order, actions: actions(row),
      evidence: row.evidence.map((entry) => ({ ...entry, id: entry.id.toString() })) });
  });

  app.get('/workflow-settings', owner, async (request, reply) => {
    const settings = await prisma.workflowSettings.findUnique({ where: { businessId: request.business!.id } });
    return success(reply, { settings, presets });
  });

  app.put('/workflow-settings', owner, async (request, reply) => {
    const { revision, ...settings } = settingsInput.parse(request.body);
    const businessId = request.business!.id;
    const saved = await prisma.$transaction(async (tx) => {
      await activeOwner(tx, businessId);
      const changed = revision === 0
        ? await tx.workflowSettings.createMany({ data: { businessId, ...settings }, skipDuplicates: true })
        : await tx.workflowSettings.updateMany({ where: { businessId, revision }, data: { ...settings, revision: { increment: 1 } } });
      if (!changed.count) throw new ConflictError('Workflow settings changed. Refresh before saving.');
      return tx.workflowSettings.findUniqueOrThrow({ where: { businessId } });
    });
    return success(reply, saved);
  });

  app.post('/workflows/:id/decision', owner, async (request, reply) => {
    const { id } = idInput.parse(request.params);
    const { approve, revision } = decisionInput.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const row = await inspect(tx, request.business!.id, id, revision);
      const now = new Date();
      const settings = await tx.workflowSettings.findUnique({ where: { businessId: row.businessId } });
      if (row.state !== 'WAITING_OWNER_APPROVAL' || !settings?.enabled || settings.revision !== row.policyRevision) {
        throw new ConflictError('Approval is no longer current');
      }
      const decision = approve ? 'APPROVED' : 'REJECTED';
      const changed = await tx.workflowApproval.updateMany({
        where: { workflowId: id, businessId: row.businessId, definitionVersion: row.version, policyRevision: row.policyRevision,
          decision: null, expiresAt: { gt: now } },
        data: { decision, decidedAt: now },
      });
      if (!changed.count) throw new ConflictError('Approval has ended');
      await transition(tx, row, {
        type: approve ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED', key: 'approval:decision',
        state: approve ? 'READY' : 'FAILED', operator: 'CARE', reason: approve ? 'OWNER_APPROVED' : 'OWNER_REJECTED',
        facts: { actor: 'business-owner', businessId: row.businessId },
      }, approve ? now : null);
    });
    return success(reply, { id });
  });

  app.post('/workflows/:id/cancel', owner, async (request, reply) => {
    const { id } = idInput.parse(request.params);
    const { revision } = commandInput.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const row = await inspect(tx, request.business!.id, id, revision);
      if (!actions(row).cancel) throw new ConflictError('Cancel committed work from its business record');
      await transition(tx, row, {
        type: 'CANCELLED', key: 'owner:cancelled', state: 'CANCELLED', operator: 'CARE', reason: 'CANCELLED_BY_OWNER',
        facts: { actor: 'business-owner', businessId: row.businessId },
      }, null);
    });
    return success(reply, { id });
  });

  app.post('/workflows/:id/retry', owner, async (request, reply) => {
    const { id } = idInput.parse(request.params);
    const { revision } = commandInput.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const row = await inspect(tx, request.business!.id, id, revision);
      if (!actions(row).retry) throw new ConflictError('This workflow has no eligible recovery');
      const settings = await tx.workflowSettings.findUnique({ where: { businessId: row.businessId } });
      if (!settings?.enabled || settings.revision !== row.policyRevision) throw new ConflictError('The execution policy changed');
      const now = new Date();
      await tx.workflow.update({ where: { id }, data: { recoveryCount: { increment: 1 } } });
      await transition(tx, row, {
        type: 'RETRY_REQUESTED', key: 'retry:' + revision, state: 'RETRY_SCHEDULED', operator: row.operator,
        reason: row.reason, deadlineAt: new Date(+now + 30 * minute),
        facts: { mode: 'reconcile-existing-effects', actor: 'business-owner' },
      }, now);
    });
    return success(reply, { id });
  });

  app.post('/workflows/:id/escalate', owner, async (request, reply) => {
    const { id } = idInput.parse(request.params);
    const { revision } = commandInput.parse(request.body);
    await prisma.$transaction(async (tx) => {
      const row = await inspect(tx, request.business!.id, id, revision);
      if (!actions(row).escalate) throw new ConflictError('This workflow cannot be escalated');
      await transition(tx, row, {
        type: 'REVIEW', key: 'owner:escalated', state: 'REVIEW_REQUIRED', operator: row.operator,
        reason: 'ESCALATED_BY_OWNER', facts: { actor: 'business-owner' },
      }, null);
    });
    return success(reply, { id });
  });
}
