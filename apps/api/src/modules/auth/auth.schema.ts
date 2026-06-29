import { z } from 'zod';

export const MetaSignupSchema = z.object({
  code: z.string().min(1, 'Meta authorization code is required'),
  phoneNumberId: z.string().min(1, 'WhatsApp phone number id is required'),
  wabaId: z.string().optional(),
});

export const MetaLoginSchema = z.object({
  code: z.string().min(1, 'Meta authorization code is required'),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export type MetaSignupInput = z.infer<typeof MetaSignupSchema>;
export type MetaLoginInput = z.infer<typeof MetaLoginSchema>;
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;
export type LogoutInput = z.infer<typeof LogoutSchema>;
