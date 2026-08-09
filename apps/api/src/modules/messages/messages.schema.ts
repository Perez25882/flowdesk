import { z } from 'zod';

export const UpdateMessageIntentSchema = z.object({
  intent: z.string().min(1),
});

export const ListMessagesQuerySchema = z.object({
  requiresReview: z.coerce.boolean().optional(),
  intent: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * A reply typed (or approved) by a person in the dashboard.
 *
 * Bounded at 4096 characters, which is WhatsApp's own limit for a text body —
 * anything longer is rejected by Meta, so refusing it here turns a silent
 * delivery failure into an error the owner can see and act on.
 */
export const SendReplySchema = z.object({
  body: z.string().trim().min(1, 'Write something to send').max(4096),
});

export type UpdateMessageIntentInput = z.infer<typeof UpdateMessageIntentSchema>;
export type ListMessagesQueryInput = z.infer<typeof ListMessagesQuerySchema>;
export type SendReplyInput = z.infer<typeof SendReplySchema>;
