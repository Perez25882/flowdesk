import { z } from 'zod';

const id = z.string().min(1).max(100);
const minor = z.number().int().min(0).max(100_000_000);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const localDate = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Use a valid local calendar date');
export const hoursInput = z.array(z.object({ day: z.number().int().min(0).max(6), open: clock, close: clock }).strict())
  .max(28).refine((hours) => hours.every(({ day, open, close }, index) => open < close && !hours.slice(index + 1)
    .some((other) => other.day === day && open < other.close && close > other.open)), 'Opening periods must be ordered and non-overlapping');
const closures = z.array(localDate).max(100).default([]);

export const settingsInput = z.object({
  enabled: z.boolean(), timeZone: z.string().min(1).max(80).refine((zone) => {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
  }, 'Enter an IANA time zone'), hours: hoursInput.refine((periods) => periods.length > 0, 'Configure at least one opening period'), closures,
  reminderMinutes: z.number().int().min(15).max(2880).nullable().default(null), followupEnabled: z.boolean().default(false),
  templateName: z.string().regex(/^[a-z0-9_]{1,80}$/).nullable().default(null),
  templateLanguage: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/).nullable().default(null),
  revision: z.number().int().min(0),
}).strict().refine((input) => Boolean(input.templateName) === Boolean(input.templateLanguage), 'Provide both template name and language');

export const resourceInput = z.object({ name: z.string().trim().min(1).max(80), staffId: id.nullable().default(null),
  hours: hoursInput.nullable().default(null), closures, active: z.boolean().default(true) }).strict();

export const serviceRules = z.object({
  category: z.enum(['PERSONAL', 'CONSULTATION', 'REPAIR', 'STAFF_ASSIGNED']),
  prepMinutes: z.number().int().min(0).max(120).default(0),
  leadMinutes: z.number().int().min(0).max(10080).default(60),
  advanceDays: z.number().int().min(1).max(90).default(30),
  holdMinutes: z.number().int().min(5).max(60).default(30),
  changeNoticeMinutes: z.number().int().min(0).max(10080).default(120),
  noShowMinutes: z.number().int().min(5).max(180).default(15),
  maximumQuantity: z.number().int().min(1).max(8).default(1),
  approvalRequired: z.boolean().default(false),
  payment: z.discriminatedUnion('kind', [z.object({ kind: z.literal('AFTER_SERVICE') }).strict(),
    z.object({ kind: z.literal('FULL') }).strict(), z.object({ kind: z.literal('FIXED'), amountMinor: minor.min(100) }).strict(),
    z.object({ kind: z.literal('PERCENT'), percent: z.number().int().min(1).max(99) }).strict()]),
  staff: z.array(id).max(24).default([]), equipment: z.array(z.array(id).min(1).max(12)).max(4).default([]),
  location: z.string().trim().min(1).max(180), deliveryArea: z.string().trim().min(1).max(140).optional(),
  instructions: z.string().trim().max(400).default(''), questions: z.array(z.string().trim().min(1).max(140)).max(5).default([]),
  stages: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
}).strict().refine(({ staff, equipment }) => new Set([...staff, ...equipment.flat()]).size === staff.length + equipment.flat().length,
  'Resource alternatives must be distinct').refine(({ category, stages, staff }) =>
  (category !== 'REPAIR' || stages.length > 0) && (category !== 'STAFF_ASSIGNED' || staff.length > 0), 'Configure stages or eligible staff for this category');

export const catalogueInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(400).default(''),
  durationMinutes: z.number().int().min(5).max(480), bufferMinutes: z.number().int().min(0).max(120).default(0),
  capacity: z.number().int().min(1).max(12), priceMinor: minor, active: z.boolean().default(true), revision: z.number().int().min(0),
  rules: serviceRules,
}).strict();

export const slotInput = z.object({ serviceId: id, from: z.string().datetime({ offset: true }), quantity: z.coerce.number().int().min(1).max(8).default(1),
  days: z.coerce.number().int().min(1).max(14).default(7) }).strict();

export const bookingInput = z.object({ serviceId: id, customerId: id, startsAt: z.string().datetime({ offset: true }),
  serviceRevision: z.number().int().min(1), settingsRevision: z.number().int().min(1), requestKey: z.string().min(8).max(100),
  leadId: id.optional(), quantity: z.number().int().min(1).max(8).default(1), location: z.string().trim().min(5).max(240).optional(),
}).strict();

export const leadInput = z.object({ customerId: id, serviceId: id.optional(), requirements: z.string().trim().min(1).max(600),
  budgetMinor: minor.optional(), preferredAt: z.string().datetime({ offset: true }).optional() }).strict();
export const qualifyInput = z.object({ revision: z.number().int().min(0), status: z.enum(['QUALIFIED', 'WAITING', 'LOST', 'DECLINED', 'UNQUALIFIED']),
  serviceId: id.optional(), assignedStaffId: id.nullable(), evidence: z.string().trim().min(3).max(600),
  followupAt: z.string().datetime({ offset: true }).nullable().default(null) }).strict();

export const actionInput = z.object({ revision: z.number().int().min(0),
  action: z.enum(['APPROVE', 'CANCEL', 'RESCHEDULE', 'REASSIGN', 'ACKNOWLEDGE', 'CHECK_IN', 'START', 'STAGE', 'BLOCK', 'RESUME', 'COMPLETE', 'NO_SHOW', 'FOLLOW_UP']),
  evidence: z.string().trim().min(3).max(600), startsAt: z.string().datetime({ offset: true }).optional(), staffId: id.optional(),
}).strict().refine(({ action, startsAt, staffId }) => (action === 'RESCHEDULE') === Boolean(startsAt) &&
  (action === 'REASSIGN') === Boolean(staffId), 'Provide a new time or a staff member when the action requires one');

export type ServiceRules = z.infer<typeof serviceRules>;
export type BusinessHours = z.infer<typeof hoursInput>;
export type BookingInput = z.infer<typeof bookingInput>;
export type VisitAction = z.infer<typeof actionInput>;
