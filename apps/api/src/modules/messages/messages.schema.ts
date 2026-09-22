import { z } from 'zod';
import { IntentType } from '@flowdesk/shared';

/**
 * A manual reclassification from the review queue.
 *
 * Narrowed to the enum the column actually holds. As a bare string, any value
 * the dashboard offered went straight into `prisma.intentCorrection.create`,
 * where a non-member threw a `PrismaClientValidationError` — which is not a
 * `PrismaClientKnownRequestError`, so it missed the mapping in the error handler
 * and reached the owner as "Internal server error" for what is an ordinary bad
 * input. Zod turns the same mistake into a 400 that names the accepted values.
 */
export const UpdateMessageIntentSchema = z.object({
  intent: z.nativeEnum(IntentType),
});

export const ListMessagesQuerySchema = z.object({
  requiresReview: z.coerce.boolean().optional(),
  // Narrowed for the same reason: the repository casts this straight into a
  // Prisma `where`, so an unknown value is a 500 rather than a 400.
  intent: z.nativeEnum(IntentType).optional(),
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

/**
 * The inbox query.
 *
 * `before` is the last row's activity time, not a page number — new messages
 * keep arriving at the top of a busy inbox and an offset would skip or repeat
 * rows as they did. `limit` is capped so one request cannot ask for the whole
 * customer table.
 */
export const ListConversationsQuerySchema = z.object({
  filter: z.enum(['all', 'needs_you']).default('all'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  before: z.coerce.date().optional(),
});

export type UpdateMessageIntentInput = z.infer<typeof UpdateMessageIntentSchema>;
export type ListMessagesQueryInput = z.infer<typeof ListMessagesQuerySchema>;
export type SendReplyInput = z.infer<typeof SendReplySchema>;
