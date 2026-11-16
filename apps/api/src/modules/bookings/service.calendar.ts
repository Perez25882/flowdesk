import type { BusinessHours } from './service.contract.js';

export const minuteMs = 60_000;
export const dayMs = 1440 * minuteMs;
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instant: Date, timeZone: string): { date: string; day: number; clock: string } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { date, day: new Date(date + 'T00:00:00Z').getUTCDay(), clock: `${values.hour}:${values.minute}` };
}

export function localSlotAllowed(startsAt: Date, now: Date, timeZone: string, leadMinutes: number, advanceDays: number): boolean {
  if (!Number.isFinite(+startsAt) || +startsAt < +now + leadMinutes * minuteMs || +startsAt % minuteMs) return false;
  const local = localParts(startsAt, timeZone);
  const startDay = Date.parse(local.date);
  return Number(local.clock.slice(3)) % 15 === 0 && startDay <= Date.parse(localParts(now, timeZone).date) + advanceDays * dayMs;
}

export function isWithinHours(start: Date, end: Date, timeZone: string, hours: BusinessHours, closed: string[]): boolean {
  const first = localParts(start, timeZone);
  const last = localParts(new Date(+end - 1), timeZone);
  if (first.date !== last.date || closed.includes(first.date)) return false;
  const period = hours.find((entry) => entry.day === first.day && first.clock >= entry.open && first.clock < entry.close);
  if (!period || last.clock < period.open || last.clock >= period.close) return false;
  // Recheck every real minute. A repeated or skipped wall-clock interval can cross an opening boundary.
  for (let value = +start + minuteMs; value < +end; value += minuteMs) {
    const local = localParts(new Date(value), timeZone);
    if (local.date !== first.date || local.clock < period.open || local.clock >= period.close) return false;
  }
  return true;
}

export function serviceTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(instant) + ` (${timeZone})`;
}
