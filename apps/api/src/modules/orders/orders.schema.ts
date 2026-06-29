import { z } from 'zod';

export const OrderStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'FULFILLED',
  'CANCELLED',
]);

export const CreateOrderItemSchema = z.object({
  productId: z.string().min(1).optional(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative().default(0),
});

export const CreateOrderSchema = z
  .object({
    customerId: z.string().min(1).optional(),
    customerPhone: z.string().min(1).optional(),
    customerName: z.string().optional(),
    rawMessage: z.string().min(1),
    items: z.array(CreateOrderItemSchema).min(1),
    notes: z.string().optional(),
  })
  .refine((data) => data.customerId || data.customerPhone, {
    message: 'Either customerId or customerPhone is required',
    path: ['customerId'],
  });

export const UpdateOrderStatusSchema = z.object({
  status: OrderStatusSchema,
  note: z.string().optional(),
});

export const AssignOrderSchema = z.object({
  staffId: z.string().min(1),
});

export const ListOrdersQuerySchema = z.object({
  status: OrderStatusSchema.optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  staffId: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const OrderStatsQuerySchema = z.object({
  period: z.enum(['today', 'week', 'month', 'custom']).default('today'),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>;
export type AssignOrderInput = z.infer<typeof AssignOrderSchema>;
export type ListOrdersQueryInput = z.infer<typeof ListOrdersQuerySchema>;
export type OrderStatsQueryInput = z.infer<typeof OrderStatsQuerySchema>;
