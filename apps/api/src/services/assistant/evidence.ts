import type { BusinessProfile } from '@flowdesk/shared';
import { normalizeGhanaPhone } from '../../utils/phone.js';

/**
 * The values an answer is allowed to contain.
 *
 * Built by the server from the exact rows it put in the prompt, BEFORE the model
 * is called. The validator then checks every money figure in the generated text
 * against this set, which is what stops a confidently wrong price reaching a
 * customer.
 *
 * Amounts are held in minor units (pesewas) so `GHS 50`, `50.00` and `50 cedis`
 * all reduce to the same integer and comparison never depends on formatting.
 */

export interface EvidenceProduct {
  id: string;
  name: string;
  unit: string;
  price: number;
  stockQuantity: number;
}

export interface EvidenceOrder {
  id: string;
  referenceNumber: string;
  status: string;
  totalAmount: number;
  amountPaid: number;
}

export interface EvidenceSet {
  /** Every currency value the answer may state, in pesewas. */
  allowedAmounts: Set<number>;
  /** Every stock count the answer may state. */
  allowedStockCounts: Set<number>;
  /** Order references belonging to THIS customer. */
  allowedOrderRefs: Set<string>;
  /** Order ids that were supplied, for checking `groundedOn`. */
  orderIds: Set<string>;
  /** Product ids that were actually supplied, for checking `groundedOn`. */
  productIds: Set<string>;
  /** Business fact keys that were actually supplied. */
  factKeys: Set<string>;
  /** The business's own numbers, the only ones an auto-send may contain. */
  ownPhoneDigits: Set<string>;
}

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Reduces a written number to one comparable form.
 *
 * Reuses the canonical Ghanaian normaliser, so `+233 24 400 0111`, `024 400
 * 0111` and `0244000111` all resolve to the same wire form. Comparing raw digits
 * would treat the local and international spellings of a shop's own number as
 * different, and the validator would then flag the shop for quoting itself.
 */
export function digitsOnly(value: string): string {
  return normalizeGhanaPhone(value);
}

export interface BuildEvidenceInput {
  products: EvidenceProduct[];
  profile: BusinessProfile | null;
  openOrders: EvidenceOrder[];
  /** Quantities the customer named, so a computed subtotal is allowed. */
  mentionedQuantities: number[];
  businessPhones: Array<string | null | undefined>;
}

/**
 * A subtotal is the most common correct answer to "how much for 3?" and appears
 * in no catalogue row, so every price × plausible quantity is precomputed and
 * allowed. Without this the validator rejects exactly the answers it should let
 * through, and the feature quietly degrades to drafting everything.
 */
const MAX_DERIVED_QUANTITY = 100;

/** A digit run this long is an identifier (a phone number), not a quantity. */
export const IDENTIFIER_DIGITS = 7;

export function buildEvidenceSet(input: BuildEvidenceInput): EvidenceSet {
  const allowedAmounts = new Set<number>();
  const allowedStockCounts = new Set<number>();
  const allowedOrderRefs = new Set<string>();
  const orderIds = new Set<string>();
  const productIds = new Set<string>();
  const factKeys = new Set<string>();
  const ownPhoneDigits = new Set<string>();

  // Quantities worth deriving totals for: the ones the customer actually named,
  // plus 1 so a bare unit price is always allowed.
  const quantities = new Set<number>([1]);
  for (const q of input.mentionedQuantities) {
    if (Number.isFinite(q) && q > 0 && q <= MAX_DERIVED_QUANTITY) {
      quantities.add(Math.round(q));
    }
  }

  const lineTotals: number[] = [];

  for (const product of input.products) {
    productIds.add(product.id);
    allowedStockCounts.add(product.stockQuantity);

    for (const quantity of quantities) {
      const total = toMinorUnits(product.price * quantity);
      allowedAmounts.add(total);
      if (quantity > 1) lineTotals.push(total);
    }
  }

  // A basket of several products summed together.
  if (lineTotals.length > 1) {
    allowedAmounts.add(lineTotals.reduce((sum, value) => sum + value, 0));
  }

  const profile = input.profile;

  if (profile) {
    if (profile.deliveryFee !== undefined && profile.deliveryFee !== null) {
      allowedAmounts.add(toMinorUnits(profile.deliveryFee));
      factKeys.add('deliveryFee');
    }
    if (profile.freeDeliveryAbove !== undefined && profile.freeDeliveryAbove !== null) {
      allowedAmounts.add(toMinorUnits(profile.freeDeliveryAbove));
      factKeys.add('freeDeliveryAbove');
    }
    if (profile.minimumOrder !== undefined && profile.minimumOrder !== null) {
      allowedAmounts.add(toMinorUnits(profile.minimumOrder));
      factKeys.add('minimumOrder');
    }
    if (profile.openingHours && profile.openingHours.days.length > 0) {
      factKeys.add('openingHours');
    }
    if (profile.deliveryAreas && profile.deliveryAreas.length > 0) {
      factKeys.add('deliveryAreas');
    }
    if (profile.paymentMethods && profile.paymentMethods.length > 0) {
      factKeys.add('paymentMethods');
    }
    if (profile.pricingStance) factKeys.add('pricingStance');
    if (profile.acceptsReturns !== undefined) factKeys.add('acceptsReturns');
    if (profile.returnWindowDays !== undefined && profile.returnWindowDays !== null) {
      factKeys.add('returnWindowDays');
    }
  }

  for (const order of input.openOrders) {
    orderIds.add(order.id);
    allowedOrderRefs.add(order.referenceNumber.toUpperCase());
    allowedAmounts.add(toMinorUnits(order.totalAmount));
    allowedAmounts.add(toMinorUnits(order.amountPaid));
    // The balance is a legitimate thing to state and appears nowhere else.
    allowedAmounts.add(toMinorUnits(order.totalAmount - order.amountPaid));
  }

  for (const phone of input.businessPhones) {
    if (phone) {
      const normalized = digitsOnly(phone);
      if (normalized.length >= IDENTIFIER_DIGITS) ownPhoneDigits.add(normalized);
    }
  }

  // Zero is always sayable: "no delivery charge", "nothing outstanding".
  allowedAmounts.add(0);

  return {
    allowedAmounts,
    allowedStockCounts,
    allowedOrderRefs,
    orderIds,
    productIds,
    factKeys,
    ownPhoneDigits,
  };
}
