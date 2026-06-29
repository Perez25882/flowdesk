import { z } from 'zod';

/**
 * Payload sent by the web client after completing Meta Embedded Signup.
 * The browser SDK returns a short-lived `code` plus the selected WABA and
 * phone number ids. The backend exchanges the code for a long-lived business
 * access token server-side (the secret never touches the browser).
 */
export const EmbeddedSignupSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  phoneNumberId: z.string().min(1, 'phoneNumberId is required'),
  wabaId: z.string().min(1).optional(),
});

/**
 * Manual connection path — used for testing or for businesses provisioning a
 * system-user token directly. Both values are validated against the Graph API
 * before being stored.
 */
export const ManualConnectSchema = z.object({
  phoneNumberId: z.string().min(1, 'phoneNumberId is required'),
  accessToken: z.string().min(1, 'accessToken is required'),
});

export type EmbeddedSignupInput = z.infer<typeof EmbeddedSignupSchema>;
export type ManualConnectInput = z.infer<typeof ManualConnectSchema>;
