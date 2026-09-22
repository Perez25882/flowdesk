import { z } from 'zod';

export const CreateServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  /**
   * Five minutes is the floor, and it is not arbitrary. A zero-length
   * appointment produces an empty time range, an empty range overlaps nothing,
   * and the constraint that stops double-booking would happily let an
   * unlimited number of them sit on the same instant.
   */
  durationMinutes: z.coerce.number().int().min(5).max(1440),
  bufferMinutes: z.coerce.number().int().min(0).max(480).default(0),
  /** Chairs, rooms, practitioners — how many of this can run at once. */
  capacity: z.coerce.number().int().min(1).max(50).default(1),
  /** Shown to the customer. Nothing is collected on a booking. */
  price: z.coerce.number().positive().nullable().optional(),
});

export const UpdateServiceSchema = CreateServiceSchema.partial().extend({
  active: z.boolean().optional(),
});

export const SlotQuerySchema = z.object({
  from: z.coerce.date().optional(),
  days: z.coerce.number().int().min(1).max(60).default(14),
  limit: z.coerce.number().int().min(1).max(60).default(40),
});

export const CreateAppointmentSchema = z.object({
  serviceId: z.string().min(1),
  customerId: z.string().min(1),
  startsAt: z.coerce.date(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const ListAppointmentsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['BOOKED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
});

export const UpdateAppointmentSchema = z.object({
  status: z.enum(['BOOKED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
  cancelReason: z.string().trim().max(200).nullable().optional(),
});

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;
export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
export type CreateAppointmentInput = z.infer<typeof CreateAppointmentSchema>;
