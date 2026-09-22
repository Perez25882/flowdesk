import type { OpeningHours } from '@flowdesk/shared';

/**
 * When a business is actually free.
 *
 * Pure, no database. The rule this exists to enforce is the one thing the
 * whole feature is judged on: a booking must never clash with another booking.
 *
 * That rule is kept in two places, on purpose, and they are not redundant:
 *
 *   Here, so the assistant and the owner are only ever OFFERED a time that is
 *   free. A customer told "3pm is available" and then refused at 3pm has been
 *   told something false by the shop.
 *
 *   In the database, as an exclusion constraint, so a time that is offered
 *   twice in the same second can still only be taken once. Checking here and
 *   inserting afterwards is a race, and two people messaging a clinic at the
 *   same moment is exactly when a race is lost.
 *
 * Neither one is the backstop for the other being sloppy. The first is about
 * telling the truth; the second is about the truth staying true.
 *
 * Ghana is UTC+0 all year with no daylight saving, so a wall-clock time and a
 * UTC time are the same thing here. That is the assumption every date in this
 * file rests on, and it is the reason opening hours can be stored as bare
 * strings without a timezone.
 */

const MINUTE = 60 * 1000;

/** `OpeningHours.days` uses these, lowercase, matching `Date.getUTCDay()` order. */
const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export interface ServiceWindow {
  durationMinutes: number;
  bufferMinutes: number;
  capacity: number;
}

export interface BusyPeriod {
  startsAt: Date;
  /** Includes the buffer — the same value the database constraint compares. */
  blockedUntil: Date;
  resourceIndex: number;
}

export interface Slot {
  startsAt: Date;
  /** What the customer is told. Excludes the buffer. */
  endsAt: Date;
  /** The whole block held in the diary, buffer included. */
  blockedUntil: Date;
  /** Which chair, room or practitioner is free at this time. */
  resourceIndex: number;
}

/** Minutes past midnight, or null when the string is not a time. */
export function minutesOfDay(time: string | null | undefined): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

export function isOpenOn(hours: OpeningHours | null | undefined, day: Date): boolean {
  if (!hours || hours.days.length === 0) return false;
  const name = DAY_NAMES[day.getUTCDay()];
  return hours.days.some((value) => String(value).toLowerCase() === name);
}

/**
 * Every free slot in a window, at a fixed rhythm.
 *
 * `stepMinutes` is the grid appointments sit on, and it is separate from the
 * service's duration on purpose. A 45-minute service offered every 45 minutes
 * gives a day of ragged times — 9:00, 9:45, 10:30 — which is how nobody books
 * anything. Offered on a 30-minute grid it gives 9:00, 9:30, 10:00, and the
 * overlap check refuses the ones that do not fit.
 *
 * Bounded by `limit` rather than by the caller trusting the date range: a
 * thirty-day window on a five-minute grid is eight thousand slots, and the
 * result of this is going into a prompt.
 */
export function availableSlots(input: {
  service: ServiceWindow;
  hours: OpeningHours | null | undefined;
  busy: BusyPeriod[];
  /** Nothing before this is offered, whatever the diary says. */
  from: Date;
  /** How many days forward to look. */
  days: number;
  stepMinutes?: number;
  limit?: number;
  /** Slots closer than this to now are not offered. */
  noticeMinutes?: number;
}): Slot[] {
  const {
    service,
    hours,
    busy,
    from,
    days,
    stepMinutes = 30,
    limit = 40,
    noticeMinutes = 60,
  } = input;

  if (service.durationMinutes <= 0 || service.capacity < 1) return [];

  const opensAt = minutesOfDay(hours?.opensAt);
  const closesAt = minutesOfDay(hours?.closesAt);
  // Without opening hours there is no honest answer about when the business is
  // free. Offering "any time" would be the assistant inventing a fact, which is
  // the one thing it must never do — so it offers nothing and says why.
  if (opensAt === null || closesAt === null || closesAt <= opensAt) return [];

  const earliest = new Date(from.getTime() + noticeMinutes * MINUTE);
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset < days && slots.length < limit; dayOffset += 1) {
    const day = new Date(startOfUtcDay(from).getTime() + dayOffset * 24 * 60 * MINUTE);
    if (!isOpenOn(hours, day)) continue;

    for (
      let minute = opensAt;
      minute + service.durationMinutes <= closesAt && slots.length < limit;
      minute += stepMinutes
    ) {
      const startsAt = new Date(day.getTime() + minute * MINUTE);
      if (startsAt < earliest) continue;

      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * MINUTE);
      const blockedUntil = new Date(endsAt.getTime() + service.bufferMinutes * MINUTE);

      const resourceIndex = freeResource(service.capacity, busy, startsAt, blockedUntil);
      if (resourceIndex === null) continue;

      slots.push({ startsAt, endsAt, blockedUntil, resourceIndex });
    }
  }

  return slots;
}

/**
 * The lowest-numbered chair free for this whole block, or null if none is.
 *
 * Lowest rather than any, so a shop with three chairs and one customer a day
 * always fills chair one. That keeps the diary readable and means a shop that
 * later reduces its capacity does not strand appointments on a chair that no
 * longer exists.
 */
export function freeResource(
  capacity: number,
  busy: BusyPeriod[],
  startsAt: Date,
  blockedUntil: Date,
): number | null {
  for (let index = 0; index < capacity; index += 1) {
    const clash = busy.some(
      (period) =>
        period.resourceIndex === index && overlaps(startsAt, blockedUntil, period),
    );
    if (!clash) return index;
  }

  return null;
}

/**
 * Half-open overlap, matching the database constraint exactly.
 *
 * An appointment ending at 10:00 and one starting at 10:00 do NOT overlap. Get
 * this wrong in the inclusive direction and a diary of back-to-back slots
 * refuses every second booking; get it wrong the other way and the constraint
 * refuses an insert this function just promised was fine.
 */
export function overlaps(startsAt: Date, blockedUntil: Date, period: BusyPeriod): boolean {
  return startsAt < period.blockedUntil && period.startsAt < blockedUntil;
}

/**
 * Whether one exact time is bookable.
 *
 * Not `availableSlots().some(...)`: a customer may ask for 3:20 when the grid
 * offers 3:00 and 3:30, and for a person on the phone that is a perfectly
 * reasonable thing to agree to. The grid is for OFFERING times; this is for
 * accepting one. The rules that actually matter — inside opening hours, on an
 * open day, far enough ahead, and not clashing — are checked directly.
 */
export function slotFor(input: {
  service: ServiceWindow;
  hours: OpeningHours | null | undefined;
  busy: BusyPeriod[];
  startsAt: Date;
  now: Date;
  noticeMinutes?: number;
}): Slot | null {
  const { service, hours, busy, startsAt, now, noticeMinutes = 60 } = input;

  if (Number.isNaN(startsAt.getTime())) return null;
  if (startsAt.getTime() < now.getTime() + noticeMinutes * MINUTE) return null;
  if (!isOpenOn(hours, startsAt)) return null;

  const opensAt = minutesOfDay(hours?.opensAt);
  const closesAt = minutesOfDay(hours?.closesAt);
  if (opensAt === null || closesAt === null) return null;

  const minuteOfDay = startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes();
  if (minuteOfDay < opensAt) return null;
  // The APPOINTMENT has to finish before closing. The buffer may run past it —
  // sweeping up after the last customer is not something the shop needs to be
  // open to the public for, and refusing the last slot of every day because of
  // a ten-minute buffer would cost a salon an appointment a day.
  if (minuteOfDay + service.durationMinutes > closesAt) return null;

  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * MINUTE);
  const blockedUntil = new Date(endsAt.getTime() + service.bufferMinutes * MINUTE);

  const resourceIndex = freeResource(service.capacity, busy, startsAt, blockedUntil);
  if (resourceIndex === null) return null;

  return { startsAt, endsAt, blockedUntil, resourceIndex };
}

/** "Tuesday 23 September, 2:30pm" — how a person says a time. */
export function describeSlot(slot: { startsAt: Date }): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  });

  return formatter.format(slot.startsAt).replace(/\u202f/g, '');
}
