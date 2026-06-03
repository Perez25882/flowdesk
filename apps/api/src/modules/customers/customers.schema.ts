import { z } from 'zod';

export const UpdateCustomerSchema = z.object({
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  blacklisted: z.boolean().optional(),
  vip: z.boolean().optional(),
});

export const ListCustomersQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
  hasBalance: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
export type ListCustomersQueryInput = z.infer<typeof ListCustomersQuerySchema>;
