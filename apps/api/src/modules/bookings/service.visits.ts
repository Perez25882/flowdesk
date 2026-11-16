import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ServiceVisit } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { invoiceAmounts } from '../commerce/commerce.invoices.js';
import type { CommerceRecoveryProbe } from '../commerce/commerce.recovery.js';
import { lockPaymentRelationship, requirePaymentActor } from '../payments/payment-relationships.js';
import { requireStaffMembership, type OrderActor } from '../orders/orders.authorization.js';
import { lockServiceBusiness, managedService, requireManagedSlot } from './service.schedule.js';
import { dayMs, minuteMs } from './service.calendar.js';
import type { BookingInput, ServiceRules, VisitAction } from './service.contract.js';
import { recordManualServiceWorkflow } from './service.workflow-store.js';
import { serviceAmounts } from './service.billing.js';

type Tx = Prisma.TransactionClient;
export type VisitSnapshot = { name: string; category: ServiceRules['category']; rules: ServiceRules; timeZone: string;
  durationMinutes: number; bufferMinutes: number; prepMinutes: number; quantity: number; location: string; instructions: string;
  totalMinor: number; depositMinor: number };

export const closedVisits = ['CANCELLED', 'EXPIRED', 'NO_SHOW'] as const;
export const noticeWindowMs = 7 * dayMs;
const visitInclude = { appointment: { select: { reference: true, startsAt: true, endsAt: true, blockedUntil: true, serviceId: true, status: true } },
  invoice: true } satisfies Prisma.ServiceVisitInclude;
type Visit = Prisma.ServiceVisitGetPayload<{ include: typeof visitInclude }>;
type Slot = Awaited<ReturnType<typeof requireManagedSlot>>;

export function snapshotOf(visit: { snapshot: Prisma.JsonValue }): VisitSnapshot {
  return visit.snapshot as unknown as VisitSnapshot;
}

async function allowManagedAppointmentWrite(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT set_config('flowdesk.service_write', 'on', true)`;
}

export async function recordVisitNotice(tx: Tx, visit: Pick<ServiceVisit, 'appointmentId' | 'scheduleRevision'>,
  kind: string, dueAt: Date, expiresAt: Date): Promise<void> {
  if (expiresAt <= dueAt) return;
  await tx.serviceVisitNotice.createMany({ data: { appointmentId: visit.appointmentId, scheduleRevision: visit.scheduleRevision, kind, dueAt, expiresAt },
    skipDuplicates: true });
}

async function recordScheduleNotices(tx: Tx, visit: Visit, now: Date, moved = false): Promise<void> {
  const settings = await tx.serviceBusinessSettings.findUnique({ where: { businessId: visit.businessId }, select: { reminderMinutes: true } });
  await recordVisitNotice(tx, visit, moved ? 'RESCHEDULED' : 'CONFIRMED', now, visit.appointment.startsAt);
  if (settings?.reminderMinutes) await recordVisitNotice(tx, visit, 'UPCOMING',
    new Date(Math.max(+now, +visit.appointment.startsAt - settings.reminderMinutes * minuteMs)), visit.appointment.startsAt);
  if (visit.assignedStaffId) await recordVisitNotice(tx, visit, 'ASSIGNED', now, visit.appointment.startsAt);
}

async function reserveResources(tx: Tx, visit: Pick<ServiceVisit, 'appointmentId' | 'businessId'>, slot: Slot): Promise<void> {
  if (!slot.resourceIds.length) return;
  await tx.serviceReservation.createMany({ data: slot.resourceIds.map((resourceId) => ({
    appointmentId: visit.appointmentId, businessId: visit.businessId, resourceId, startsAt: slot.blockedFrom, endsAt: slot.blockedUntil,
  })) });
}

async function releaseSlot(tx: Tx, visit: Visit, state: 'CANCELLED' | 'EXPIRED' | 'NO_SHOW', now: Date, evidence: string, staffId: string | null): Promise<Visit> {
  await allowManagedAppointmentWrite(tx);
  await tx.appointment.update({ where: { id: visit.appointmentId }, data: { status: state === 'NO_SHOW' ? state : 'CANCELLED',
    ...(state === 'NO_SHOW' ? {} : { cancelledAt: now, cancelReason: evidence }) } });
  await tx.serviceReservation.updateMany({ where: { appointmentId: visit.appointmentId, releasedAt: null }, data: { releasedAt: now } });
  const amounts = visit.invoice ? await invoiceAmounts(tx, visit.invoice) : null;
  const updated = await tx.serviceVisit.update({ where: { appointmentId: visit.appointmentId }, data: { state, holdUntil: null,
    ...(amounts?.paid.gt(0) ? { paymentReviewAt: now } : {}), scheduleRevision: { increment: 1 }, revision: { increment: 1 },
    history: { create: { revision: visit.revision + 1, action: state, evidence, staffId } } }, include: visitInclude });
  if (state !== 'EXPIRED') await recordVisitNotice(tx, updated, state, now, new Date(+now + noticeWindowMs));
  return updated;
}

async function expireTenantHolds(tx: Tx, businessId: string, now: Date): Promise<void> {
  const overdue = await tx.serviceVisit.findMany({ where: { businessId, state: 'HELD', holdUntil: { lte: now } },
    include: visitInclude, take: 32, orderBy: { holdUntil: 'asc' } });
  for (const visit of overdue) await releaseSlot(tx, visit, 'EXPIRED', now, 'Booking hold expired', null);
}

export async function createServiceVisit(tx: Tx, businessId: string, input: BookingInput, actor: OrderActor | null, now = new Date()): Promise<Visit> {
  if (actor) {
    await requirePaymentActor(tx, businessId, actor.staffId, 'orders.create');
    await requireStaffMembership(tx, actor);
    if (actor.staffId && actor.role !== 'MANAGER') throw new ForbiddenError('A manager must schedule a service');
  }
  const customerId = input.customerId;
  await lockPaymentRelationship(tx, { businessId, customerId });
  await lockServiceBusiness(tx, businessId);
  if (!await tx.customer.findFirst({ where: { id: customerId, businessId, blacklisted: false }, select: { id: true } })) {
    throw new NotFoundError('Customer unavailable');
  }
  const requestHash = createHash('sha256').update(JSON.stringify([customerId, input.serviceId, new Date(input.startsAt).toISOString(),
    input.quantity, input.leadId ?? null, input.location ?? null, input.serviceRevision, input.settingsRevision])).digest('hex');
  const prior = await tx.serviceVisit.findUnique({ where: { businessId_requestKey: { businessId, requestKey: input.requestKey } }, include: visitInclude });
  if (prior) {
    if (prior.requestHash !== requestHash) throw new ConflictError('Booking request belongs to different terms');
    return prior;
  }
  const { service, settings, rules } = await managedService(tx, businessId, input.serviceId);
  if (service.bookingRevision !== input.serviceRevision || settings.revision !== input.settingsRevision) {
    throw new ConflictError('Service price or calendar changed. Refresh availability.');
  }
  if (rules.deliveryArea && !input.location) throw new ConflictError('Provide a customer-confirmed location inside the configured service area');
  if (input.location && !rules.deliveryArea) throw new ConflictError('This service is available at the configured location');
  if (rules.deliveryArea && !actor) throw new ConflictError('Staff must verify the service location');
  if (input.leadId) {
    const [lead] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM service_leads WHERE id = ${input.leadId}
      AND "businessId" = ${businessId} AND "customerId" = ${customerId} AND "serviceId" = ${input.serviceId}
      AND status = 'QUALIFIED' FOR UPDATE`;
    if (!lead) throw new ConflictError('Qualified lead is unavailable');
  }
  const { total, deposit } = serviceAmounts(service.price, input.quantity, rules.payment);
  if (deposit.gt(total) || (deposit.gt(0) && deposit.lt(1)) || (total.gt(0) && total.lt(1))) throw new ConflictError('Service payment terms are invalid');
  await expireTenantHolds(tx, businessId, now);
  const startsAt = new Date(input.startsAt);
  const slot = await requireManagedSlot(tx, businessId, service.id, service, settings, rules, startsAt, input.quantity, now, customerId);
  const needsHold = rules.approvalRequired || deposit.gt(0);
  const holdUntil = needsHold ? new Date(Math.min(+now + rules.holdMinutes * minuteMs, +slot.blockedFrom)) : null;
  if (holdUntil && holdUntil <= now) throw new ConflictError('The selected time leaves no approval or payment window');
  const reference = 'FD-A-S' + randomUUID().replaceAll('-', '').toUpperCase();
  await allowManagedAppointmentWrite(tx);
  const appointment = await tx.appointment.create({ data: { businessId, customerId, serviceId: service.id, reference,
    startsAt, endsAt: slot.endsAt, blockedUntil: slot.blockedUntil, resourceIndex: slot.resourceIndex, status: needsHold ? 'BOOKED' : 'CONFIRMED' } });
  const invoice = total.gt(0) ? await tx.commerceInvoice.create({ data: { businessId, customerId, reference: 'INV-' + reference,
    total, deposit, releaseThreshold: deposit.gt(0) ? deposit : total, dueAt: new Date(+slot.endsAt + dayMs),
    terms: rules.payment.kind === 'AFTER_SERVICE' ? 'Pay after service' : 'Verified deposit required before appointment confirmation',
    receiptLines: [{ name: service.name, quantity: input.quantity, unitPrice: service.price?.toFixed(2) ?? '0.00', subtotal: total.toFixed(2) }],
  } }) : null;
  const snapshot: VisitSnapshot = { name: service.name, category: rules.category, rules, timeZone: settings.timeZone,
    durationMinutes: service.durationMinutes, bufferMinutes: service.bufferMinutes, prepMinutes: rules.prepMinutes,
    quantity: input.quantity, location: input.location ?? rules.location, instructions: rules.instructions,
    totalMinor: Number(total.mul(100)), depositMinor: Number(deposit.mul(100)) };
  const visit = await tx.serviceVisit.create({ data: { appointmentId: appointment.id, businessId, customerId, leadId: input.leadId ?? null,
    requestKey: input.requestKey, requestHash, invoiceId: invoice?.id ?? null, approvalRequired: rules.approvalRequired, holdUntil,
    state: needsHold ? 'HELD' : 'CONFIRMED', assignedStaffId: slot.assignedStaffId, snapshot: snapshot as Prisma.InputJsonValue,
    history: { create: { revision: 0, action: needsHold ? 'HOLD_CREATED' : 'CONFIRMED', staffId: actor?.staffId ?? null } },
  }, include: visitInclude });
  await reserveResources(tx, visit, slot);
  if (input.leadId) await tx.serviceLead.update({ where: { id: input.leadId }, data: { status: 'BOOKED', revision: { increment: 1 } } });
  else if (actor) await recordManualServiceWorkflow(tx, { businessId, customerId }, appointment.id, now, appointment.id);
  if (!needsHold) await recordScheduleNotices(tx, visit, now);
  if (holdUntil) await recordVisitNotice(tx, visit, 'HOLD_CREATED', now, holdUntil);
  if (deposit.gt(0) && holdUntil) await recordVisitNotice(tx, visit, 'DEPOSIT', new Date(+now + 5 * minuteMs), holdUntil);
  return visit;
}

async function confirmEligibleHold(tx: Tx, visit: Visit, now: Date): Promise<Visit> {
  if (visit.state !== 'HELD') return visit;
  if (visit.holdUntil && visit.holdUntil <= now) return releaseSlot(tx, visit, 'EXPIRED', now, 'Booking hold expired', null);
  const snapshot = snapshotOf(visit);
  if (visit.approvalRequired && !visit.approvedAt) return visit;
  if (snapshot.depositMinor && (!visit.invoice || (await invoiceAmounts(tx, visit.invoice)).verified.mul(100).lt(snapshot.depositMinor))) return visit;
  if (!await tx.customer.findFirst({ where: { id: visit.customerId, businessId: visit.businessId, deletedAt: null, blacklisted: false }, select: { id: true } }) ||
      await tx.serviceReservation.findFirst({ where: { appointmentId: visit.appointmentId, releasedAt: null, resource: { active: false } }, select: { id: true } })) return visit;
  if (visit.assignedStaffId && !await tx.staff.findFirst({ where: { id: visit.assignedStaffId, businessId: visit.businessId,
    active: true, role: { in: ['MANAGER', 'OPERATIONS'] } }, select: { id: true } })) return visit;
  await allowManagedAppointmentWrite(tx);
  await tx.appointment.update({ where: { id: visit.appointmentId }, data: { status: 'CONFIRMED' } });
  const confirmed = await tx.serviceVisit.update({ where: { appointmentId: visit.appointmentId }, data: { state: 'CONFIRMED', holdUntil: null,
    revision: { increment: 1 }, history: { create: { revision: visit.revision + 1, action: 'CONFIRMED' } } }, include: visitInclude });
  await recordScheduleNotices(tx, confirmed, now);
  return confirmed;
}

async function lockVisit(tx: Tx, businessId: string, appointmentId: string): Promise<Visit> {
  const initial = await tx.serviceVisit.findFirst({ where: { appointmentId, businessId }, select: { customerId: true } });
  if (!initial) throw new NotFoundError('Appointment not found');
  await lockPaymentRelationship(tx, { businessId, customerId: initial.customerId }, true);
  await lockServiceBusiness(tx, businessId);
  return tx.serviceVisit.findUniqueOrThrow({ where: { appointmentId_businessId: { appointmentId, businessId } }, include: visitInclude });
}

export async function recoverServiceVisits(now: Date, probe?: CommerceRecoveryProbe): Promise<void> {
  const visits = await prisma.$queryRaw<{ appointmentId: string; businessId: string }[]>`
    SELECT v."appointmentId", v."businessId" FROM service_visits v JOIN businesses b ON b.id = v."businessId"
    WHERE b.active AND b."deletedAt" IS NULL AND b."deactivatedAt" IS NULL AND b."suspendedAt" IS NULL AND (
      (v.state = 'HELD' AND (v."holdUntil" <= ${now} OR ((NOT v."approvalRequired" OR v."approvedAt" IS NOT NULL)
        AND EXISTS (SELECT 1 FROM payments p JOIN paystack_settlements s ON s."paymentId" = p.id
          WHERE p."invoiceId" = v."invoiceId" AND p."voidedAt" IS NULL))))
      OR (v.state IN ('CANCELLED','EXPIRED','NO_SHOW') AND v."paymentReviewAt" IS NULL
        AND EXISTS (SELECT 1 FROM payments p JOIN paystack_settlements s ON s."paymentId" = p.id
          WHERE p."invoiceId" = v."invoiceId"))) ORDER BY v."holdUntil" NULLS LAST, v."appointmentId" LIMIT 16
  `;
  for (const candidate of visits) await prisma.$transaction(async (tx) => {
    const visit = await lockVisit(tx, candidate.businessId, candidate.appointmentId);
    if (visit.state === 'HELD' && (await confirmEligibleHold(tx, visit, now)).state === 'CONFIRMED') {
      await probe?.('before-service-confirmation-commit');
    }
    if ((closedVisits as readonly string[]).includes(visit.state) && !visit.paymentReviewAt && visit.invoice) {
      await tx.serviceVisit.update({ where: { appointmentId: visit.appointmentId }, data: { paymentReviewAt: now,
        revision: { increment: 1 }, history: { create: { revision: visit.revision + 1, action: 'LATE_PAYMENT_REVIEW' } } } });
    }
  });
}

const workerTransitions: Partial<Record<VisitAction['action'], { from: string[]; to: string }>> = {
  ACKNOWLEDGE: { from: ['CONFIRMED'], to: 'ACKNOWLEDGED' }, CHECK_IN: { from: ['CONFIRMED', 'ACKNOWLEDGED'], to: 'CHECKED_IN' },
  START: { from: ['CHECKED_IN'], to: 'IN_PROGRESS' }, STAGE: { from: ['IN_PROGRESS'], to: 'IN_PROGRESS' },
  BLOCK: { from: ['IN_PROGRESS'], to: 'BLOCKED' }, RESUME: { from: ['BLOCKED'], to: 'IN_PROGRESS' },
  COMPLETE: { from: ['IN_PROGRESS'], to: 'COMPLETED' },
};

export async function updateServiceVisit(tx: Tx, actor: OrderActor, id: string, input: VisitAction, now = new Date()): Promise<Visit> {
  await requirePaymentActor(tx, actor.businessId, actor.staffId, 'orders.transition');
  await requireStaffMembership(tx, actor);
  const manager = actor.staffId === null || actor.role === 'MANAGER';
  const visit = await lockVisit(tx, actor.businessId, id);
  if (!manager && (actor.role !== 'OPERATIONS' || actor.staffId !== visit.assignedStaffId)) throw new NotFoundError('Appointment not found');
  if (visit.revision !== input.revision) throw new ConflictError('Appointment has changed');
  const { action, evidence } = input;
  const snapshot = snapshotOf(visit);
  if (action === 'APPROVE') {
    if (!manager || visit.state !== 'HELD' || !visit.approvalRequired || visit.approvedAt || !visit.holdUntil || visit.holdUntil <= now) {
      throw new ConflictError('Appointment approval is no longer eligible');
    }
    const change = await tx.serviceVisit.update({ where: { appointmentId: id }, data: { approvedAt: now, revision: { increment: 1 },
      history: { create: { revision: visit.revision + 1, action, evidence, staffId: actor.staffId } } }, include: visitInclude });
    return confirmEligibleHold(tx, change, now);
  }
  if (action === 'CANCEL' || action === 'NO_SHOW') {
    if (!manager || !['HELD', 'CONFIRMED', 'ACKNOWLEDGED', ...(action === 'CANCEL' ? ['CHECKED_IN', 'IN_PROGRESS', 'BLOCKED'] : [])].includes(visit.state) ||
        (action === 'NO_SHOW' && (visit.state === 'HELD' || +now < +visit.appointment.startsAt + snapshot.rules.noShowMinutes * minuteMs)) ||
        (action === 'CANCEL' && visit.state !== 'HELD' && +now < +visit.appointment.startsAt &&
          +now > +visit.appointment.startsAt - snapshot.rules.changeNoticeMinutes * minuteMs)) {
      throw new ConflictError('Appointment does not permit that attendance action');
    }
    return releaseSlot(tx, visit, action === 'CANCEL' ? 'CANCELLED' : 'NO_SHOW', now, evidence, actor.staffId);
  }
  if (action === 'RESCHEDULE' || action === 'REASSIGN') {
    if (!manager || !['CONFIRMED', 'ACKNOWLEDGED'].includes(visit.state) ||
      (action === 'RESCHEDULE' && +now > +visit.appointment.startsAt - snapshot.rules.changeNoticeMinutes * minuteMs)) {
      throw new ConflictError('This appointment cannot be changed now');
    }
    const { settings, service, rules } = await managedService(tx, actor.businessId, visit.appointment.serviceId);
    const startsAt = input.startsAt ? new Date(input.startsAt) : visit.appointment.startsAt;
    const slot = await requireManagedSlot(tx, actor.businessId, service.id, { ...snapshot, capacity: service.capacity }, settings,
      { ...snapshot.rules, staff: rules.staff, equipment: rules.equipment, ...(action === 'REASSIGN' ? { leadMinutes: 0 } : {}) },
      startsAt, snapshot.quantity, now, visit.customerId, id, input.staffId);
    await tx.serviceReservation.updateMany({ where: { appointmentId: id, releasedAt: null }, data: { releasedAt: now } });
    await reserveResources(tx, visit, slot);
    await allowManagedAppointmentWrite(tx);
    await tx.appointment.update({ where: { id }, data: { startsAt, endsAt: slot.endsAt, blockedUntil: slot.blockedUntil, resourceIndex: slot.resourceIndex } });
    const change = await tx.serviceVisit.update({ where: { appointmentId: id }, data: { state: 'CONFIRMED', assignedStaffId: slot.assignedStaffId,
      scheduleRevision: { increment: 1 }, revision: { increment: 1 }, history: { create: { revision: visit.revision + 1, action,
        evidence: `${evidence} | ${visit.appointment.startsAt.toISOString()} -> ${startsAt.toISOString()}`, staffId: actor.staffId } } }, include: visitInclude });
    await recordScheduleNotices(tx, change, now, true);
    return change;
  }
  if (action === 'FOLLOW_UP') {
    if (!manager || visit.state !== 'COMPLETED') throw new ConflictError('Follow-up requires a completed service');
    if (!await tx.serviceBusinessSettings.findUnique({ where: { businessId: actor.businessId, followupEnabled: true } })) {
      throw new ConflictError('Service follow-ups are disabled');
    }
    await recordVisitNotice(tx, visit, 'FOLLOW_UP', now, new Date(+now + noticeWindowMs));
    return visit;
  }
  const rule = workerTransitions[action];
  if (!rule?.from.includes(visit.state) || (action === 'CHECK_IN' && +now < +visit.appointment.startsAt - 30 * minuteMs) ||
      (action === 'STAGE' && visit.stageIndex >= snapshot.rules.stages.length) ||
      (action === 'COMPLETE' && visit.stageIndex < snapshot.rules.stages.length)) throw new ConflictError('Service activity requires the preceding evidence');
  if (snapshot.depositMinor && (!visit.invoice || (await invoiceAmounts(tx, visit.invoice)).verified.mul(100).lt(snapshot.depositMinor))) {
    throw new ConflictError('The verified deposit requires reconciliation');
  }
  if (visit.assignedStaffId && !await tx.staff.findFirst({ where: { id: visit.assignedStaffId, businessId: actor.businessId,
    active: true, role: { in: ['MANAGER', 'OPERATIONS'] } }, select: { id: true } })) throw new ConflictError('Reassign ineligible staff before recording work');
  if (action === 'COMPLETE') {
    await allowManagedAppointmentWrite(tx);
    await tx.appointment.update({ where: { id }, data: { status: 'COMPLETED' } });
  }
  const updated = await tx.serviceVisit.update({ where: { appointmentId: id }, data: { state: rule.to, revision: { increment: 1 },
    ...(action === 'STAGE' ? { stageIndex: { increment: 1 } } : {}),
    history: { create: { revision: visit.revision + 1, action, evidence, staffId: actor.staffId } } }, include: visitInclude });
  if (action === 'COMPLETE') await recordVisitNotice(tx, updated, action, now, new Date(+now + noticeWindowMs));
  return updated;
}
