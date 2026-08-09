import { z } from 'zod';

export const CreateProductSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  unit: z.string().min(1),
  price: z.coerce.number().positive(),
  stockQuantity: z.coerce.number().nonnegative().default(0),
  reorderThreshold: z.coerce.number().nonnegative().default(0),
  aliases: z.array(z.string()).default([]),
});

export const UpdateProductSchema = CreateProductSchema.partial().extend({
  active: z.boolean().optional(),
});

export const StockAdjustmentSchema = z
  .object({
    /**
     * RESTOCK expects a positive amount to add. ADJUSTMENT takes a signed
     * delta, so a correction downwards is sent as a negative number.
     */
    quantity: z.coerce.number().finite(),
    type: z.enum(['RESTOCK', 'ADJUSTMENT']),
    note: z.string().max(500).optional(),
  })
  .refine((data) => data.type !== 'RESTOCK' || data.quantity > 0, {
    message: 'A restock quantity must be greater than zero',
    path: ['quantity'],
  })
  .refine((data) => data.quantity !== 0, {
    message: 'A stock adjustment of zero has no effect',
    path: ['quantity'],
  });

export const ListProductsQuerySchema = z.object({
  search: z.string().optional(),
  active: z.coerce.boolean().optional(),
  lowStock: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type StockAdjustmentInput = z.infer<typeof StockAdjustmentSchema>;
export type ListProductsQueryInput = z.infer<typeof ListProductsQuerySchema>;
