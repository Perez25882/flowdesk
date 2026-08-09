import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '@flowdesk/shared';

export const InviteStaffSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  role: z.enum(['MANAGER', 'OPERATIONS', 'DELIVERY']),
});

/**
 * Staff passwords are held to the same length as the owner's.
 *
 * They were previously allowed at six characters while owners needed ten, which
 * left the accounts most exposed to reuse and shared devices as the weakest way
 * into a business.
 */
export const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

export const StaffLoginSchema = z.object({
  phone: z.string().min(1),
  password: z.string().min(1),
});

export const UpdateStaffSchema = z.object({
  role: z.enum(['MANAGER', 'OPERATIONS', 'DELIVERY']).optional(),
  active: z.boolean().optional(),
});

export type InviteStaffInput = z.infer<typeof InviteStaffSchema>;
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;
export type StaffLoginInput = z.infer<typeof StaffLoginSchema>;
export type UpdateStaffInput = z.infer<typeof UpdateStaffSchema>;
