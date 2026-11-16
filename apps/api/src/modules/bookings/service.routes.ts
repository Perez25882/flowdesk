import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireCapability } from '../../middleware/role.middleware.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { created, success } from '../../utils/response.js';
import { orderActor, orderActorHasCapability, requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { lockPaymentRelationship, requirePaymentActor } from '../payments/payment-relationships.js';
import { actionInput, bookingInput, catalogueInput, leadInput, qualifyInput, resourceInput, settingsInput, slotInput } from './service.contract.js';
import { lockServiceBusiness, managedService, managedSlots } from './service.schedule.js';
import { createServiceVisit, snapshotOf, updateServiceVisit } from './service.visits.js';
import { recordManualServiceWorkflow } from './service.workflow-store.js';
import { serviceAmounts } from './service.billing.js';

type Tx = Prisma.TransactionClient;
const idParam = z.object({ id: z.string().min(1).max(100) }).strict();
const managementRoles = new Set(['MANAGER']);

function isManager(actor: OrderActor): boolean {
  return actor.staffId === null || managementRoles.has(actor.role ?? '');
}

async function manager(tx: Tx, actor: OrderActor, lock = true): Promise<void> {
  if (!isManager(actor)) throw new ForbiddenError('Service management requires an owner or manager');
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'orders.create');
  await requireStaffMembership(tx, actor);
  if (lock) await lockServiceBusiness(tx, actor.businessId);
}

async function requireEligibleStaff(tx: Tx, businessId: string, staffId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff
    WHERE id = ${staffId} AND "businessId" = ${businessId} AND role IN ('MANAGER','OPERATIONS') AND active FOR SHARE`;
  if (!row) throw new NotFoundError('Eligible staff member not found');
}

const operationalVisit = {
  appointmentId: true, state: true, revision: true, stageIndex: true, assignedStaffId: true, snapshot: true,
  appointment: { select: { reference: true, startsAt: true, endsAt: true, customer: { select: { name: true } } } },
  history: { select: { revision: true, action: true, evidence: true, createdAt: true }, orderBy: { revision: 'asc' } },
} satisfies Prisma.ServiceVisitSelect;

function operationalView(visit: Prisma.ServiceVisitGetPayload<{ select: typeof operationalVisit }>) {
  const { snapshot: stored, ...fields } = visit;
  const { name, category, timeZone, location, instructions, rules } = snapshotOf({ snapshot: stored });
  return { ...fields, service: { name, category, timeZone, location, instructions, stages: rules.stages } };
}

export default async function serviceRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: requireCapability('orders.read') };
  const write = { preHandler: requireCapability('orders.create') };
  const act = { preHandler: requireCapability('orders.transition') };

  app.get('/service-operations', read, async (request, reply) => {
    const actor = orderActor(request);
    await requireStaffMembership(prisma, actor);
    if (!isManager(actor) && actor.role !== 'OPERATIONS') throw new ForbiddenError('Service work requires eligible staff');
    const { businessId, staffId } = actor;
    const where = { businessId, ...(!isManager(actor) && staffId ? { assignedStaffId: staffId } : {}) };
    const visits = await prisma.serviceVisit.findMany({ where, select: operationalVisit, orderBy: { appointment: { startsAt: 'desc' } }, take: 100 });
    if (!isManager(actor)) return success(reply, { visits: visits.map(operationalView) });
    const [settings, services, resources, leads, staff, details, revenue] = await Promise.all([
      prisma.serviceBusinessSettings.findUnique({ where: { businessId } }),
      prisma.service.findMany({ where: { businessId, deletedAt: null, bookingRules: { not: Prisma.DbNull } }, orderBy: { name: 'asc' }, take: 100 }),
      prisma.serviceResource.findMany({ where: { businessId }, orderBy: { name: 'asc' }, take: 200 }),
      prisma.serviceLead.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100,
        include: { supportCase: { select: { id: true, state: true } } } }),
      prisma.staff.findMany({ where: { businessId, active: true, role: { in: ['MANAGER', 'OPERATIONS'] } },
        select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.serviceVisit.findMany({ where: { businessId, appointmentId: { in: visits.map((visit) => visit.appointmentId) } },
        select: { appointmentId: true, leadId: true, customerId: true, holdUntil: true, approvalRequired: true, approvedAt: true,
          ...(orderActorHasCapability(actor, 'payments.read') ? { invoiceId: true, paymentReviewAt: true } : {}),
          notices: { select: { kind: true, dueAt: true, checkedAt: true, reason: true, sendId: true }, orderBy: { dueAt: 'asc' } } } }),
      orderActorHasCapability(actor, 'revenue.read') ? prisma.payment.groupBy({ by: ['direction'], _sum: { amount: true },
        where: { businessId, voidedAt: null, invoice: { serviceVisit: { businessId, state: 'COMPLETED' } },
          OR: [{ direction: 'IN', confidence: 'GATEWAY_CONFIRMED', paystackSettlement: { isNot: null } },
            { direction: 'OUT', confidence: { not: 'CLAIMED' } }] } }) : null,
    ]);
    const sendIds = details.flatMap(({ notices }) => notices.flatMap(({ sendId }) => sendId ? [sendId] : []));
    const sends = await prisma.whatsAppSend.findMany({ where: { businessId, id: { in: sendIds } }, select: { id: true, state: true, reason: true } });
    const byId = new Map(sends.map(({ id, ...send }) => [id, send]));
    const byAppointment = new Map(details.map((entry) => [entry.appointmentId, { ...entry,
      notices: entry.notices.map((notice) => ({ ...notice, send: notice.sendId ? byId.get(notice.sendId) ?? null : null })) }]));
    const closedServiceRevenue = revenue?.reduce((total, { direction, _sum }) =>
      direction === 'IN' ? total.plus(_sum.amount ?? 0) : total.minus(_sum.amount ?? 0), new Prisma.Decimal(0));
    return success(reply, { settings, services, resources, leads, staff,
      ...(closedServiceRevenue ? { closedServiceRevenue: closedServiceRevenue.toFixed(2) } : {}),
      visits: visits.map((visit) => ({ ...operationalView(visit), ...byAppointment.get(visit.appointmentId) })) });
  });

  app.put('/service-operations/settings', write, async (request, reply) => {
    const actor = orderActor(request);
    const { revision, ...input } = settingsInput.parse(request.body);
    const settings = await prisma.$transaction(async (tx) => {
      await manager(tx, actor);
      const current = await tx.serviceBusinessSettings.findUnique({ where: { businessId: actor.businessId } });
      if ((current?.revision ?? 0) !== revision) throw new ConflictError('Availability setting changed. Reload it.');
      if (!current) return tx.serviceBusinessSettings.create({ data: { ...input, businessId: actor.businessId } });
      const changedTemplate = current.templateName !== input.templateName || current.templateLanguage !== input.templateLanguage;
      return tx.serviceBusinessSettings.update({ where: { businessId: actor.businessId }, data: { ...input, revision: { increment: 1 },
        ...(changedTemplate ? { approvedAt: null, approvedPhoneId: null, approvedWabaId: null, templateCheckedAt: null } : {}) } });
    });
    return success(reply, settings);
  });

  const saveResource = (actor: OrderActor, input: z.infer<typeof resourceInput>, id?: string) => prisma.$transaction(async (tx) => {
    await manager(tx, actor);
    if (!await tx.serviceBusinessSettings.findUnique({ where: { businessId: actor.businessId } })) throw new ConflictError('Configure business hours first');
    if (input.staffId) await requireEligibleStaff(tx, actor.businessId, input.staffId);
    const data = { ...input, hours: input.hours ?? Prisma.DbNull };
    if (!id) return tx.serviceResource.create({ data: { ...data, businessId: actor.businessId } });
    const row = await tx.serviceResource.findUnique({ where: { id_businessId: { id, businessId: actor.businessId } } });
    if (!row) throw new NotFoundError('Service resource not found');
    if (row.staffId !== input.staffId) throw new ConflictError('Create a resource for the new staff member');
    return tx.serviceResource.update({ where: { id }, data });
  });
  app.post('/service-operations/resources', write, async (request, reply) =>
    created(reply, await saveResource(orderActor(request), resourceInput.parse(request.body))));
  app.put('/service-operations/resources/:id', write, async (request, reply) =>
    success(reply, await saveResource(orderActor(request), resourceInput.parse(request.body), idParam.parse(request.params).id)));

  const saveService = (actor: OrderActor, input: z.infer<typeof catalogueInput>, id?: string) => prisma.$transaction(async (tx) => {
    await manager(tx, actor);
    if (!await tx.serviceBusinessSettings.findUnique({ where: { businessId: actor.businessId } })) throw new ConflictError('Configure business hours first');
    const { revision, priceMinor, rules, ...attributes } = input;
    const price = new Prisma.Decimal(priceMinor).div(100);
    const invalidTerms = Array.from({ length: rules.maximumQuantity }, (_, index) => index + 1).some((quantity) => {
      const { total, deposit } = serviceAmounts(price, quantity, rules.payment);
      const balance = total.minus(deposit);
      return total.gt(1_000_000) || balance.lt(0) || (balance.gt(0) && balance.lt(1)) ||
        (rules.payment.kind !== 'AFTER_SERVICE' && deposit.lt(1));
    });
    if (invalidTerms) throw new ConflictError('Service total, deposit and balance must fit the supported checkout amounts');
    const resources = await tx.serviceResource.findMany({ where: { businessId: actor.businessId, active: true,
      id: { in: [...rules.staff, ...rules.equipment.flat()] } }, select: { id: true, staffId: true } });
    if (rules.staff.some((key) => !resources.some((resource) => resource.id === key && resource.staffId)) ||
      rules.equipment.flat().some((key) => !resources.some((resource) => resource.id === key && !resource.staffId))) {
      throw new NotFoundError('Eligible service resources not found');
    }
    const duplicates = await tx.service.findMany({ where: { businessId: actor.businessId, deletedAt: null,
      bookingRules: { not: Prisma.DbNull }, name: { equals: input.name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
    if (duplicates.length) throw new ConflictError('Use a distinct service name');
    const data = { ...attributes, price, bookingRules: rules };
    await tx.$queryRaw`SELECT set_config('flowdesk.service_write', 'on', true)`;
    if (!id && revision === 0) return tx.service.create({ data: { ...data, businessId: actor.businessId, bookingRevision: 1 } });
    const present = id && await tx.service.findFirst({ where: { id, businessId: actor.businessId, deletedAt: null, bookingRules: { not: Prisma.DbNull } } });
    if (!present) throw new NotFoundError('Configured service not found');
    if (present.bookingRevision !== revision) throw new ConflictError('Service changed. Reload it.');
    return tx.service.update({ where: { id: present.id }, data: { ...data, bookingRevision: { increment: 1 } } });
  });
  app.post('/service-operations/catalogue', write, async (request, reply) =>
    created(reply, await saveService(orderActor(request), catalogueInput.parse(request.body))));
  app.put('/service-operations/catalogue/:id', write, async (request, reply) =>
    success(reply, await saveService(orderActor(request), catalogueInput.parse(request.body), idParam.parse(request.params).id)));

  app.get('/service-operations/slots', write, async (request, reply) => {
    const actor = orderActor(request);
    const { serviceId, from, days, quantity } = slotInput.parse(request.query);
    const slots = await prisma.$transaction(async (tx) => {
      await manager(tx, actor, false);
      return managedSlots(tx, actor.businessId, serviceId, new Date(from), days, quantity);
    });
    return success(reply, slots);
  });

  app.post('/service-operations/leads', write, async (request, reply) => {
    const actor = orderActor(request);
    const { preferredAt, ...input } = leadInput.parse(request.body);
    const row = await prisma.$transaction(async (tx) => {
      await manager(tx, actor, false);
      await lockPaymentRelationship(tx, { businessId: actor.businessId, customerId: input.customerId });
      await lockServiceBusiness(tx, actor.businessId);
      if (input.serviceId) await managedService(tx, actor.businessId, input.serviceId);
      const lead = await tx.serviceLead.create({ data: { ...input, serviceId: input.serviceId ?? null, budgetMinor: input.budgetMinor ?? null,
        businessId: actor.businessId, preferredAt: preferredAt ? new Date(preferredAt) : null } });
      const workflow = await recordManualServiceWorkflow(tx, lead, lead.id, new Date());
      return tx.serviceLead.update({ where: { id: lead.id }, data: { workflowId: workflow.id } });
    });
    return created(reply, row);
  });

  app.patch('/service-operations/leads/:id', write, async (request, reply) => {
    const actor = orderActor(request);
    const { id } = idParam.parse(request.params);
    const input = qualifyInput.parse(request.body);
    const row = await prisma.$transaction(async (tx) => {
      await manager(tx, actor, false);
      const scope = { id, businessId: actor.businessId };
      const existing = await tx.serviceLead.findFirst({ where: scope });
      if (!existing) throw new NotFoundError('Lead not found');
      await lockPaymentRelationship(tx, existing);
      await lockServiceBusiness(tx, actor.businessId);
      const current = await tx.serviceLead.findFirstOrThrow({ where: scope });
      if (current.revision !== input.revision || ['BOOKED', 'CARE', 'LOST', 'DECLINED', 'UNQUALIFIED'].includes(current.status)) {
        throw new ConflictError('Lead is no longer available for qualification');
      }
      const serviceId = input.serviceId ?? current.serviceId;
      if (serviceId) await managedService(tx, actor.businessId, serviceId);
      if (input.status === 'QUALIFIED' && !serviceId) throw new ConflictError('Choose the service before qualifying');
      if (input.assignedStaffId) await requireEligibleStaff(tx, actor.businessId, input.assignedStaffId);
      return tx.serviceLead.update({ where: { id }, data: { status: input.status, serviceId, assignedStaffId: input.assignedStaffId,
        followupAt: input.followupAt ? new Date(input.followupAt) : null, revision: { increment: 1 },
        evidence: [...(Array.isArray(current.evidence) ? current.evidence as Prisma.InputJsonArray : []),
          { status: input.status, evidence: input.evidence, staffId: actor.staffId, at: new Date().toISOString() }] } });
    });
    return success(reply, row);
  });

  app.post('/service-operations/visits', write, async (request, reply) => {
    const actor = orderActor(request);
    const input = bookingInput.parse(request.body);
    const result = await prisma.$transaction((tx) => createServiceVisit(tx, actor.businessId, input, actor));
    return created(reply, { appointmentId: result.appointmentId, state: result.state, revision: result.revision });
  });

  app.post('/service-operations/visits/:id/actions', act, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const action = actionInput.parse(request.body);
    const result = await prisma.$transaction((tx) => updateServiceVisit(tx, orderActor(request), id, action));
    return success(reply, { appointmentId: result.appointmentId, state: result.state, revision: result.revision });
  });
}
