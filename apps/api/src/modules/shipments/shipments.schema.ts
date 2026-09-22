import { z } from 'zod';

/**
 * Courier and tracking are both optional, and that is deliberate.
 *
 * Plenty of Accra shops dispatch on a motorbike belonging to someone's cousin.
 * Requiring a waybill number would either stop them recording the dispatch at
 * all or teach them to type "n/a", and a column full of "n/a" is worse than a
 * column full of nulls because it cannot be queried for absence.
 */
export const DispatchOrderSchema = z.object({
  courier: z.string().trim().min(1).max(80).optional(),
  trackingNumber: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(500).optional(),
});

export type DispatchOrderInput = z.infer<typeof DispatchOrderSchema>;

export const ProofOfDispatchSchema = z.object({
  /** Bare base64, or a `data:image/...;base64,` URL as `FileReader` produces. */
  image: z.string().min(1),
});
