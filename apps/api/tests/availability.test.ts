import { describe, expect, it } from 'vitest';
import {
  availableSlots,
  describeSlot,
  freeResource,
  minutesOfDay,
  overlaps,
  slotFor,
  type BusyPeriod,
} from '../src/modules/bookings/availability.js';

/**
 * The promise is that a booking never clashes with another booking. These
 * tests are the half of that promise the application is responsible for: never
 * OFFERING a time that is not free. The other half is a database constraint,
 * which no test here can bypass.
 */

// A Tuesday.
const NOW = new Date('2026-09-22T08:00:00Z');
const HOURS = {
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  opensAt: '09:00',
  closesAt: '17:00',
} as never;

const SERVICE = { durationMinutes: 30, bufferMinutes: 0, capacity: 1 };

function busy(start: string, until: string, resourceIndex = 0): BusyPeriod {
  return { startsAt: new Date(start), blockedUntil: new Date(until), resourceIndex };
}

describe('minutesOfDay', () => {
  it('reads a time', () => {
    expect(minutesOfDay('09:00')).toBe(540);
    expect(minutesOfDay('17:30')).toBe(1050);
    expect(minutesOfDay('00:00')).toBe(0);
  });

  it('refuses anything that is not one', () => {
    for (const value of ['', null, undefined, 'nine', '25:00', '09:75', '9']) {
      expect(minutesOfDay(value as string)).toBeNull();
    }
  });
});

describe('overlaps — half open, exactly like the database constraint', () => {
  it('does not treat back-to-back appointments as a clash', () => {
    // The single most expensive thing to get wrong here: an inclusive
    // comparison refuses every second slot in a back-to-back diary.
    const existing = busy('2026-09-22T09:00:00Z', '2026-09-22T09:30:00Z');
    expect(
      overlaps(new Date('2026-09-22T09:30:00Z'), new Date('2026-09-22T10:00:00Z'), existing),
    ).toBe(false);
  });

  it('catches an appointment starting one minute inside another', () => {
    const existing = busy('2026-09-22T09:00:00Z', '2026-09-22T09:30:00Z');
    expect(
      overlaps(new Date('2026-09-22T09:29:00Z'), new Date('2026-09-22T09:59:00Z'), existing),
    ).toBe(true);
  });

  it('catches an appointment that swallows another whole', () => {
    const existing = busy('2026-09-22T10:00:00Z', '2026-09-22T10:15:00Z');
    expect(
      overlaps(new Date('2026-09-22T09:00:00Z'), new Date('2026-09-22T12:00:00Z'), existing),
    ).toBe(true);
  });
});

describe('availableSlots', () => {
  it('offers nothing when the business has not said when it opens', () => {
    // Guessing would be inventing a fact about the business.
    expect(
      availableSlots({ service: SERVICE, hours: null, busy: [], from: NOW, days: 7 }),
    ).toEqual([]);
  });

  it('offers nothing on a day the business is closed', () => {
    const saturday = new Date('2026-09-26T08:00:00Z');
    const slots = availableSlots({
      service: SERVICE,
      hours: HOURS,
      busy: [],
      from: saturday,
      days: 1,
    });
    expect(slots).toEqual([]);
  });

  it('starts at opening time and stops so the appointment ends by closing', () => {
    const slots = availableSlots({
      service: SERVICE,
      hours: HOURS,
      busy: [],
      from: NOW,
      days: 1,
      limit: 100,
    });

    expect(slots[0]!.startsAt.toISOString()).toBe('2026-09-22T09:00:00.000Z');
    const last = slots.at(-1)!;
    expect(last.endsAt.toISOString()).toBe('2026-09-22T17:00:00.000Z');
    expect(last.startsAt.toISOString()).toBe('2026-09-22T16:30:00.000Z');
  });

  it('will not offer a time inside the notice period', () => {
    const slots = availableSlots({
      service: SERVICE,
      hours: HOURS,
      busy: [],
      from: new Date('2026-09-22T09:10:00Z'),
      days: 1,
      noticeMinutes: 60,
      limit: 100,
    });
    // 10:10 plus notice means the first offerable slot on the grid is 10:30.
    expect(slots[0]!.startsAt.toISOString()).toBe('2026-09-22T10:30:00.000Z');
  });

  it('skips a slot that is taken, and keeps the ones either side', () => {
    const slots = availableSlots({
      service: SERVICE,
      hours: HOURS,
      busy: [busy('2026-09-22T10:00:00Z', '2026-09-22T10:30:00Z')],
      from: NOW,
      days: 1,
      limit: 100,
    });

    const times = slots.map((s) => s.startsAt.toISOString());
    expect(times).toContain('2026-09-22T09:30:00.000Z');
    expect(times).not.toContain('2026-09-22T10:00:00.000Z');
    expect(times).toContain('2026-09-22T10:30:00.000Z');
  });

  it('blocks the buffer as well as the appointment', () => {
    // 30 minutes of work plus a 15-minute buffer at 10:00 runs to 10:45, so
    // the 10:30 slot is gone even though the customer leaves at 10:30.
    const withBuffer = { durationMinutes: 30, bufferMinutes: 15, capacity: 1 };
    const slots = availableSlots({
      service: withBuffer,
      hours: HOURS,
      busy: [busy('2026-09-22T10:00:00Z', '2026-09-22T10:45:00Z')],
      from: NOW,
      days: 1,
      limit: 100,
    });

    const times = slots.map((s) => s.startsAt.toISOString());
    expect(times).not.toContain('2026-09-22T10:30:00.000Z');
    expect(times).toContain('2026-09-22T11:00:00.000Z');
  });

  it('keeps offering a time until every chair is taken', () => {
    const threeChairs = { durationMinutes: 30, bufferMinutes: 0, capacity: 3 };
    const at10 = (index: number) => busy('2026-09-22T10:00:00Z', '2026-09-22T10:30:00Z', index);

    const twoTaken = availableSlots({
      service: threeChairs,
      hours: HOURS,
      busy: [at10(0), at10(1)],
      from: NOW,
      days: 1,
      limit: 100,
    });
    const tenOClock = twoTaken.find((s) => s.startsAt.toISOString() === '2026-09-22T10:00:00.000Z');
    expect(tenOClock?.resourceIndex).toBe(2);

    const allTaken = availableSlots({
      service: threeChairs,
      hours: HOURS,
      busy: [at10(0), at10(1), at10(2)],
      from: NOW,
      days: 1,
      limit: 100,
    });
    expect(
      allTaken.some((s) => s.startsAt.toISOString() === '2026-09-22T10:00:00.000Z'),
    ).toBe(false);
  });

  it('runs a long service on a shorter grid, so times stay round', () => {
    // 45 minutes offered every 45 minutes gives 9:00, 9:45, 10:30 — times
    // nobody books. On a 30-minute grid they stay readable.
    const long = { durationMinutes: 45, bufferMinutes: 0, capacity: 1 };
    const slots = availableSlots({
      service: long,
      hours: HOURS,
      busy: [],
      from: NOW,
      days: 1,
      stepMinutes: 30,
      limit: 4,
    });

    expect(slots.map((s) => s.startsAt.toISOString().slice(11, 16))).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
    ]);
  });

  it('never returns more than the limit, however wide the window', () => {
    const slots = availableSlots({
      service: SERVICE,
      hours: HOURS,
      busy: [],
      from: NOW,
      days: 60,
      limit: 12,
    });
    expect(slots).toHaveLength(12);
  });
});

describe('slotFor — accepting a time the customer named', () => {
  const ask = (iso: string, overrides = {}) =>
    slotFor({ service: SERVICE, hours: HOURS, busy: [], startsAt: new Date(iso), now: NOW, ...overrides });

  it('accepts a time off the grid, because a person would', () => {
    // 3:20pm is not a slot anyone was offered, and it is a perfectly normal
    // thing for a customer to ask for.
    expect(ask('2026-09-22T15:20:00Z')).not.toBeNull();
  });

  it('refuses a time in the past', () => {
    expect(ask('2026-09-22T07:00:00Z')).toBeNull();
  });

  it('refuses a time inside the notice period', () => {
    expect(ask('2026-09-22T08:30:00Z')).toBeNull();
  });

  it('refuses a day the business is closed', () => {
    expect(ask('2026-09-27T10:00:00Z')).toBeNull();
  });

  it('refuses before opening and after closing', () => {
    expect(ask('2026-09-22T08:00:00Z')).toBeNull();
    expect(ask('2026-09-22T16:45:00Z')).toBeNull();
    expect(ask('2026-09-22T16:30:00Z')).not.toBeNull();
  });

  it('lets the buffer run past closing time', () => {
    // Sweeping up after the last customer does not need the doors open, and
    // refusing the last slot every day over a 10-minute buffer costs a salon
    // an appointment a day.
    const withBuffer = { durationMinutes: 30, bufferMinutes: 15, capacity: 1 };
    const result = slotFor({
      service: withBuffer,
      hours: HOURS,
      busy: [],
      startsAt: new Date('2026-09-22T16:30:00Z'),
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.blockedUntil.toISOString()).toBe('2026-09-22T17:15:00.000Z');
  });

  it('refuses a time that clashes', () => {
    const result = slotFor({
      service: SERVICE,
      hours: HOURS,
      busy: [busy('2026-09-22T15:00:00Z', '2026-09-22T15:30:00Z')],
      startsAt: new Date('2026-09-22T15:15:00Z'),
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('refuses an invalid date rather than producing an invalid range', () => {
    expect(ask('not a date')).toBeNull();
  });
});

describe('freeResource', () => {
  it('always fills the lowest free chair', () => {
    expect(freeResource(3, [], new Date(NOW), new Date(NOW.getTime() + 60_000))).toBe(0);
  });

  it('returns null when every chair is busy', () => {
    const periods = [0, 1].map((i) => busy('2026-09-22T10:00:00Z', '2026-09-22T11:00:00Z', i));
    expect(
      freeResource(2, periods, new Date('2026-09-22T10:30:00Z'), new Date('2026-09-22T10:45:00Z')),
    ).toBeNull();
  });
});

describe('describeSlot', () => {
  it('reads the way a person says a time', () => {
    expect(describeSlot({ startsAt: new Date('2026-09-22T14:30:00Z') })).toBe(
      'Tuesday 22 September at 2:30 pm',
    );
  });
});
