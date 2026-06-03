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

export type UpdateMessageIntentInput = z.infer<typeof UpdateMessageIntentSchema>;
export type ListMessagesQueryInput = z.infer<typeof ListMessagesQuerySchema>;
