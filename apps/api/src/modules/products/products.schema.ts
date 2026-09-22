import { z } from 'zod';

/**
 * A bulk price break.
 *
 * `minQuantity` starts at 2 because a "tier" that applies to one unit is just
 * the price, and letting one through would give a shop two different list
 * prices that disagree.
 */
export const QuantityTierSchema = z.object({
  minQuantity: z.coerce.number().int().min(2).max(100_000),
  percentOff: z.coerce.number().int().min(1).max(90),
});

const PricingFields = {
  /**
   * The lowest the assistant may agree to. Null clears it, which switches this
   * product back to a single non-negotiable price.
   *
   * Checked against `price` below rather than in isolation: a floor above the
   * list price is almost always a typo, and accepting it silently would leave
   * an owner believing they had protected a margin they had not.
   */
  floorPrice: z.coerce.number().positive().nullable().optional(),
  discountPercent: z.coerce.number().int().min(1).max(90).nullable().optional(),
  discountLabel: z.string().max(40).nullable().optional(),
  discountEndsAt: z.coerce.date().nullable().optional(),
  tiers: z.array(QuantityTierSchema).max(5).optional(),
};

/** A floor above the price is a typo, and one tier repeated is an accident. */
function refinePricing<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
  return schema
    .superRefine((data: Record<string, unknown>, ctx) => {
      const floor = data.floorPrice;
      const price = data.price;
      if (typeof floor === 'number' && typeof price === 'number' && floor > price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['floorPrice'],
          message: 'The lowest price cannot be above the normal price',
        });
      }

      const tiers = data.tiers;
      if (Array.isArray(tiers)) {
        const quantities = tiers.map((t: { minQuantity: number }) => t.minQuantity);
        if (new Set(quantities).size !== quantities.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers'],
            message: 'Two bulk prices cannot start at the same quantity',
          });
        }
      }
    }) as unknown as z.ZodEffects<T>;
}

const CreateProductFields = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  unit: z.string().min(1),
  price: z.coerce.number().positive(),
  stockQuantity: z.coerce.number().nonnegative().default(0),
  reorderThreshold: z.coerce.number().nonnegative().default(0),
  aliases: z.array(z.string()).default([]),
  ...PricingFields,
});

export const CreateProductSchema = refinePricing(CreateProductFields);

export const UpdateProductSchema = refinePricing(
  CreateProductFields.partial().extend({
    active: z.boolean().optional(),
  }),
);

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

export type QuantityTierInput = z.infer<typeof QuantityTierSchema>;
export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type StockAdjustmentInput = z.infer<typeof StockAdjustmentSchema>;
export type ListProductsQueryInput = z.infer<typeof ListProductsQuerySchema>;
