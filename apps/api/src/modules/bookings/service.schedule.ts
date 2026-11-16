import type { Prisma, Service, ServiceBusinessSettings } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { dayMs, isWithinHours, localSlotAllowed, minuteMs, serviceTime } from './service.calendar.js';
import { hoursInput, serviceRules, type ServiceRules } from './service.contract.js';
import { HOLDING_STATUSES } from './bookings.service.js';
import { serviceAmounts } from './service.billing.js';

type Tx = Prisma.TransactionClient;
type Timing = { durationMinutes: number; bufferMinutes: number; capacity: number };
type Selection = { startsAt: Date; endsAt: Date; blockedFrom: Date; blockedUntil: Date; resourceIndex: number;
  resourceIds: string[]; assignedStaffId: string | null };

export async function lockServiceBusiness(tx: Tx, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'service-calendar:' + businessId}, 0))`;
  const [active] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM businesses WHERE id = ${businessId}
    AND active AND "deletedAt" IS NULL AND "deactivatedAt" IS NULL AND "suspendedAt" IS NULL FOR SHARE`;
  if (!active) throw new NotFoundError('Business not available');
}

export async function managedService(tx: Tx, businessId: string, serviceId: string): Promise<{
  service: Service; settings: ServiceBusinessSettings; rules: ServiceRules;
}> {
  const settings = await tx.serviceBusinessSettings.findUnique({ where: { businessId } });
  if (!settings?.enabled) throw new ConflictError('Configure service operations first');
  const service = await tx.service.findFirst({ where: { id: serviceId, businessId, active: true, deletedAt: null } });
  if (!service?.bookingRules) throw new NotFoundError('Configured service not found');
  return { settings, service, rules: serviceRules.parse(service.bookingRules) };
}

async function availabilityFacts(tx: Tx, businessId: string, serviceId: string, rules: ServiceRules,
  from: Date, to: Date, excluded?: string, customerId?: string) {
  const ids = [...rules.staff, ...rules.equipment.flat()];
  const [resources, staff, resourceBlocks, appointments] = await Promise.all([
    tx.serviceResource.findMany({ where: { businessId, id: { in: ids }, active: true } }),
    tx.staff.findMany({ where: { businessId, active: true, role: { in: ['MANAGER', 'OPERATIONS'] } }, select: { id: true } }),
    tx.serviceReservation.findMany({ where: { businessId, resourceId: { in: ids }, releasedAt: null, startsAt: { lt: to }, endsAt: { gt: from },
      ...(excluded ? { appointmentId: { not: excluded } } : {}) }, select: { resourceId: true, startsAt: true, endsAt: true } }),
    tx.appointment.findMany({ where: { businessId, status: { in: HOLDING_STATUSES }, startsAt: { lt: new Date(+to + 120 * minuteMs) },
      blockedUntil: { gt: from }, OR: [{ serviceId }, ...(customerId ? [{ customerId }] : [])], ...(excluded ? { id: { not: excluded } } : {}) },
    select: { customerId: true, serviceId: true, startsAt: true, blockedUntil: true, resourceIndex: true, serviceVisit: { select: { snapshot: true } } } }),
  ]);
  const availableStaff = new Set(staff.map(({ id }) => id));
  const lanes = appointments.map((row) => ({ ...row, startsAt: new Date(+row.startsAt -
    Number((row.serviceVisit?.snapshot as { prepMinutes?: number } | undefined)?.prepMinutes ?? 0) * minuteMs) }));
  return { resources, availableStaff, resourceBlocks, lanes };
}

function selectSlot(timing: Timing, settings: ServiceBusinessSettings, rules: ServiceRules, facts: Awaited<ReturnType<typeof availabilityFacts>>,
  serviceId: string, startsAt: Date, quantity: number, now: Date, customerId?: string, desiredStaff?: string): Selection | null {
  if (quantity > rules.maximumQuantity || !localSlotAllowed(startsAt, now, settings.timeZone, rules.leadMinutes, rules.advanceDays)) return null;
  const endsAt = new Date(+startsAt + timing.durationMinutes * quantity * minuteMs);
  const blockedFrom = new Date(+startsAt - rules.prepMinutes * minuteMs);
  const blockedUntil = new Date(+endsAt + timing.bufferMinutes * minuteMs);
  if (+blockedFrom < +now || !isWithinHours(blockedFrom, blockedUntil, settings.timeZone, hoursInput.parse(settings.hours), settings.closures)) return null;
  const busy = facts.lanes.filter((row) => row.startsAt < blockedUntil && row.blockedUntil > blockedFrom);
  if (customerId && busy.some((row) => row.customerId === customerId)) return null;
  const used = new Set(busy.filter((row) => row.serviceId === serviceId).map((row) => row.resourceIndex));
  const resourceIndex = Array.from({ length: timing.capacity }, (_, index) => index).find((index) => !used.has(index));
  if (resourceIndex === undefined) return null;
  const pick = (pool: string[], staffOnly: boolean) => pool.map((id) => facts.resources.find((resource) => resource.id === id)).find((resource) =>
    resource && (staffOnly ? resource.staffId && facts.availableStaff.has(resource.staffId) && (!desiredStaff || resource.staffId === desiredStaff) : !resource.staffId) &&
    (resource.hours ? isWithinHours(blockedFrom, blockedUntil, settings.timeZone, hoursInput.parse(resource.hours), resource.closures) :
      isWithinHours(blockedFrom, blockedUntil, settings.timeZone, hoursInput.parse(settings.hours), resource.closures)) &&
    !facts.resourceBlocks.some((block) => block.resourceId === resource.id && block.startsAt < blockedUntil && block.endsAt > blockedFrom));
  const assigned = rules.staff.length ? pick(rules.staff, true) : undefined;
  if ((!assigned && rules.staff.length) || (desiredStaff && !assigned)) return null;
  const equipment = rules.equipment.map((pool) => pick(pool, false));
  if (equipment.some((resource) => !resource)) return null;
  return { startsAt, endsAt, blockedFrom, blockedUntil, resourceIndex,
    resourceIds: [...(assigned ? [assigned.id] : []), ...equipment.map((resource) => resource!.id)], assignedStaffId: assigned?.staffId ?? null };
}

export async function requireManagedSlot(tx: Tx, businessId: string, serviceId: string, timing: Timing,
  settings: ServiceBusinessSettings, rules: ServiceRules, startsAt: Date, quantity: number, now: Date,
  customerId: string, excluded?: string, desiredStaff?: string): Promise<Selection> {
  const facts = await availabilityFacts(tx, businessId, serviceId, rules, new Date(+startsAt - rules.prepMinutes * minuteMs),
    new Date(+startsAt + (timing.durationMinutes * quantity + timing.bufferMinutes) * minuteMs), excluded, customerId);
  const slot = selectSlot(timing, settings, rules, facts, serviceId, startsAt, quantity, now, customerId, desiredStaff);
  if (!slot) throw new ConflictError('That time or its required resources are unavailable');
  if (slot.assignedStaffId) {
    const [eligible] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff WHERE id = ${slot.assignedStaffId}
      AND "businessId" = ${businessId} AND active AND role IN ('MANAGER','OPERATIONS') FOR SHARE`;
    if (!eligible) throw new ConflictError('The staff member is no longer eligible');
  }
  return slot;
}

export async function managedSlots(tx: Tx, businessId: string, serviceId: string, from: Date, days: number, quantity: number,
  now = new Date()) {
  const { service, settings, rules } = await managedService(tx, businessId, serviceId);
  const first = Math.max(+from, +now + rules.leadMinutes * minuteMs);
  const bound = first + days * dayMs;
  const facts = await availabilityFacts(tx, businessId, serviceId, rules, new Date(first - 120 * minuteMs), new Date(bound + 4 * dayMs));
  const slots: { startsAt: Date; endsAt: Date; localTime: string }[] = [];
  const step = 15 * minuteMs;
  for (let value = Math.ceil(first / step) * step; value < bound && slots.length < 24; value += step) {
    const slot = selectSlot(service, settings, rules, facts, serviceId, new Date(value), quantity, now);
    if (slot) slots.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, localTime: serviceTime(slot.startsAt, settings.timeZone) });
  }
  const { deposit, total } = serviceAmounts(service.price, quantity, rules.payment);
  return { slots, serviceRevision: service.bookingRevision, settingsRevision: settings.revision,
    terms: { total: total.toFixed(2), deposit: deposit.toFixed(2), currency: 'GHS', approvalRequired: rules.approvalRequired,
      paymentPolicy: rules.payment.kind, quantity, durationMinutes: service.durationMinutes * quantity } };
}
