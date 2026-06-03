import { z } from 'zod';

export const RegisterBusinessSchema = z.object({
  ownerName: z.string().min(2).max(100),
  phone: z.string().min(10).max(15),
  businessName: z.string().min(2).max(150),
});

export const RequestOTPSchema = z.object({
  phone: z.string().min(10).max(15),
});

export const VerifyOTPSchema = z.object({
  phone: z.string().min(10).max(15),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterBusinessInput = z.infer<typeof RegisterBusinessSchema>;
export type RequestOTPInput = z.infer<typeof RequestOTPSchema>;
export type VerifyOTPInput = z.infer<typeof VerifyOTPSchema>;
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;
export type LogoutInput = z.infer<typeof LogoutSchema>;
