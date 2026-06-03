import { z } from 'zod';

export const InviteStaffSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  role: z.enum(['MANAGER', 'OPERATIONS', 'DELIVERY']),
});

export const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
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
