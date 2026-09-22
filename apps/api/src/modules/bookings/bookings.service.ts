import { Prisma } from '@prisma/client';
import type { AppointmentStatus } from '@prisma/client';
import type { BusinessProfile, OpeningHours } from '@flowdesk/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import {
  availableSlots,
  slotFor,
  type BusyPeriod,
  type Slot,
} from './availability.js';

/**
 * Booking a time, and the one thing that must never happen.
 *
 * Two customers message a clinic in the same second and both are told 3pm is
 * free. Both are. Then both book it. Checking availability and then inserting
 * is a read followed by a write with a gap in between, and that gap is where
 * every double-booking that has ever happened, happened.
 *
 * So the check is not what keeps the promise. The database has an exclusion
 * constraint that makes two overlapping live appointments on the same service
 * and resource physically impossible to store, and this module's job is to
 * lose that race gracefully: catch the violation, refresh what is free, and
 * tell the caller the slot went rather than returning a 500 to a customer who
 * did nothing wrong.
 *
 * `availableSlots` is still called first, and not redundantly — it is what
 * stops the shop OFFERING a time it cannot honour, which is a different
 * failure from taking one twice.
 */

/** Postgres: exclusion constraint violated. Prisma surfaces it as a raw code. */
const EXCLUSION_VIOLATION = '23P01';

const REFERENCE_PREFIX = 'FD-A-';

/** Live for the purposes of the diary: these hold a slot, the others release it. */
export const HOLDING_STATUSES: AppointmentStatus[] = ['BOOKED', 'CONFIRMED', 'COMPLETED'];

export interface BookableService {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  capacity: number;
  price: number | null;
}

function openingHoursFor(profile: unknown): OpeningHours | null {
  if (typeof profile !== 'object' || profile === null) return null;
  return (profile as BusinessProfile).openingHours ?? null;
}

export async function listServices(
  businessId: string,
  activeOnly = false,
): Promise<BookableService[]> {
  const rows = await prisma.service.findMany({
    where: { businessId, deletedAt: null, ...(activeOnly ? { active: true } : {}) },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      bufferMinutes: true,
      capacity: true,
      price: true,
    },
  });

  return rows.map((row) => ({ ...row, price: row.price === null ? null : Number(row.price) }));
}

/**
 * What is already taken, for one service, over a window.
 *
 * Scoped to the service rather than the whole business because that is exactly
 * what the constraint is scoped to. Two different services at a clinic — a
 * consultation and a blood test — are separate diaries unless the owner has
 * said otherwise by giving them the same capacity, and pretending otherwise
 * would make a busy Tuesday look fully booked for everything.
 */
export async function busyPeriods(
  serviceId: string,
  from: Date,
  to: Date,
): Promise<BusyPeriod[]> {
  const rows = await prisma.appointment.findMany({
    where: {
      serviceId,
      status: { in: HOLDING_STATUSES },
      // An appointment that started before the window can still run into it,
      // so the filter is on the END of the block, not the start.
      blockedUntil: { gt: from },
      startsAt: { lt: to },
    },
    select: { startsAt: true, blockedUntil: true, resourceIndex: true },
  });

  return rows;
}

export interface SlotQuery {
  serviceId: string;
  from?: Date;
  days?: number;
  limit?: number;
}

export async function findSlots(
  businessId: string,
  query: SlotQuery,
): Promise<{ service: BookableService; slots: Slot[]; reason: string | null }> {
  const [service, business] = await Promise.all([
    prisma.service.findFirst({
      where: { id: query.serviceId, businessId, deletedAt: null, active: true },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        bufferMinutes: true,
        capacity: true,
        price: true,
      },
    }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { businessProfile: true },
    }),
  ]);

  if (!service) throw new NotFoundError('Service not found');

  const bookable: BookableService = {
    ...service,
    price: service.price === null ? null : Number(service.price),
  };

  const hours = openingHoursFor(business?.businessProfile);
  if (!hours || hours.days.length === 0 || !hours.opensAt || !hours.closesAt) {
    // Said plainly rather than returning an empty list, because "no times
    // available" and "nobody has told us when you are open" look identical to
    // a customer and mean completely different things to an owner.
    return { service: bookable, slots: [], reason: 'no_opening_hours' };
  }

  const from = query.from ?? new Date();
  const days = query.days ?? 14;
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

  const busy = await busyPeriods(service.id, from, to);

  const slots = availableSlots({
    service: bookable,
    hours,
    busy,
    from,
    days,
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });

  return {
    service: bookable,
    slots,
    reason: slots.length === 0 ? 'fully_booked' : null,
  };
}

export interface BookInput {
  businessId: string;
  serviceId: string;
  customerId: string;
  startsAt: Date;
  notes?: string | null;
  byAssistant?: boolean;
}

/**
 * Takes a time.
 *
 * Retries once on a clash. Once, not five: a second attempt is worth making
 * because the most likely cause is a resource index that was free a
 * millisecond ago and is the one thing a refresh can fix. Beyond that, the
 * honest answer is that the time went, and a loop would only make a customer
 * wait longer to be told so.
 */
export async function book(input: BookInput): Promise<{ id: string; reference: string } & Slot> {
  const [service, business] = await Promise.all([
    prisma.service.findFirst({
      where: { id: input.serviceId, businessId: input.businessId, deletedAt: null, active: true },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        bufferMinutes: true,
        capacity: true,
        price: true,
      },
    }),
    prisma.business.findUnique({
      where: { id: input.businessId },
      select: { businessProfile: true },
    }),
  ]);

  if (!service) throw new NotFoundError('Service not found');

  const hours = openingHoursFor(business?.businessProfile);
  const now = new Date();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const busy = await busyPeriods(
      service.id,
      new Date(input.startsAt.getTime() - 24 * 60 * 60 * 1000),
      new Date(input.startsAt.getTime() + 24 * 60 * 60 * 1000),
    );

    const slot = slotFor({
      service: {
        durationMinutes: service.durationMinutes,
        bufferMinutes: service.bufferMinutes,
        capacity: service.capacity,
      },
      hours,
      busy,
      startsAt: input.startsAt,
      now,
    });

    if (!slot) throw new ConflictError('That time is not available');

    const reference = await nextReference(input.businessId);

    try {
      const created = await prisma.appointment.create({
        data: {
          businessId: input.businessId,
          serviceId: service.id,
          customerId: input.customerId,
          reference,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          blockedUntil: slot.blockedUntil,
          resourceIndex: slot.resourceIndex,
          notes: input.notes ?? null,
          bookedByAssistant: input.byAssistant ?? false,
        },
        select: { id: true, reference: true },
      });

      return { ...created, ...slot };
    } catch (error: unknown) {
      if (!isOverlapViolation(error)) throw error;

      logger.warn(
        { businessId: input.businessId, serviceId: service.id, attempt },
        'Appointment slot taken between check and insert',
      );

      if (attempt === 2) throw new ConflictError('That time was just taken');
    }
  }

  throw new ConflictError('That time was just taken');
}

/**
 * Whether this error is the exclusion constraint refusing an overlap.
 *
 * Matched on the Postgres error code rather than on the message, which is
 * localised and has changed wording between major versions. `P2010` is a raw
 * query failure and `P2002` a unique violation — neither is this, and treating
 * one as this would silently swallow a different bug.
 */
export function isOverlapViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;

  const meta = error.meta as { code?: string; constraint?: string } | undefined;
  if (meta?.code === EXCLUSION_VIOLATION) return true;

  return typeof meta?.constraint === 'string' && meta.constraint === 'appointments_no_overlap';
}

/**
 * The next reference for this business.
 *
 * Derived from the highest already issued rather than from a counter, because
 * appointments are a fraction of the volume of orders and a fresh query is
 * cheaper than another Redis key to keep warm. The unique index is what
 * actually guarantees it, and a collision surfaces as a normal error rather
 * than as two appointments sharing a number.
 */
async function nextReference(businessId: string): Promise<string> {
  const latest = await prisma.appointment.findFirst({
    where: { businessId, reference: { startsWith: REFERENCE_PREFIX } },
    orderBy: { createdAt: 'desc' },
    select: { reference: true },
  });

  const current = latest
    ? Number.parseInt(latest.reference.slice(REFERENCE_PREFIX.length), 10)
    : 0;

  const next = Number.isNaN(current) ? Date.now() % 100000 : current + 1;
  return `${REFERENCE_PREFIX}${String(next).padStart(5, '0')}`;
}

export async function cancelAppointment(
  id: string,
  businessId: string,
  reason: string | null,
): Promise<void> {
  // Conditional on still holding the slot, so cancelling twice is not an error
  // and cancelling something already completed does not rewrite history.
  const result = await prisma.appointment.updateMany({
    where: { id, businessId, status: { in: ['BOOKED', 'CONFIRMED'] } },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
  });

  if (result.count === 0) throw new NotFoundError('Appointment not found, or already finished');
}

export async function setStatus(
  id: string,
  businessId: string,
  status: AppointmentStatus,
): Promise<void> {
  const result = await prisma.appointment.updateMany({
    where: { id, businessId },
    data: { status, ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}) },
  });

  if (result.count === 0) throw new NotFoundError('Appointment not found');
}

export interface AppointmentRow {
  id: string;
  reference: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  notes: string | null;
  resourceIndex: number;
  bookedByAssistant: boolean;
  service: { id: string; name: string; capacity: number };
  customer: { id: string; name: string | null; waNumber: string };
}

export async function listAppointments(
  businessId: string,
  filters: { from?: Date; to?: Date; status?: AppointmentStatus },
): Promise<AppointmentRow[]> {
  return prisma.appointment.findMany({
    where: {
      businessId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? {
            startsAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lt: filters.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { startsAt: 'asc' },
    take: 200,
    select: {
      id: true,
      reference: true,
      startsAt: true,
      endsAt: true,
      status: true,
      notes: true,
      resourceIndex: true,
      bookedByAssistant: true,
      service: { select: { id: true, name: true, capacity: true } },
      customer: { select: { id: true, name: true, waNumber: true } },
    },
  });
}
