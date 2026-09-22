import { z } from 'zod';

/**
 * Account credentials are email + password. Meta OAuth is used only to attach a
 * WhatsApp number to an existing account (see the whatsapp module) — it is not
 * an identity provider, so losing Facebook access never locks an owner out of
 * their business data.
 */

/** Emails are stored lowercase so lookups and the unique index are consistent. */
const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(320);

/**
 * Minimum length is the primary defence; complexity rules push users toward
 * predictable substitutions without materially increasing entropy. The upper
 * bound exists because bcrypt silently truncates beyond 72 bytes — accepting a
 * longer password would give a false sense of strength.
 */
const passwordField = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters');

export const RegisterSchema = z.object({
  businessName: z.string().trim().min(2, 'Business name is required').max(200),
  ownerName: z.string().trim().min(2, 'Your name is required').max(200),
  email: emailField,
  password: passwordField,
  phone: z.string().trim().min(9).max(20).optional(),
});

export const LoginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required').max(72),
});

export const ForgotPasswordSchema = z.object({
  email: emailField,
});

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: passwordField,
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: passwordField,
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;
export type LogoutInput = z.infer<typeof LogoutSchema>;

/**
 * Six digits, and nothing clever.
 *
 * Trimmed and stripped of spaces before validation because a code pasted out of
 * an email client regularly arrives as "123 456", and rejecting that would be
 * rejecting the user for the mail client's formatting.
 */
export const VerifyEmailSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Enter the six digit code from your email')),
});
