import type { BusinessProfile } from '@flowdesk/shared';
import { normalizeGhanaPhone } from '../../utils/phone.js';
import type { PriceLadder } from '../pricing/ladder.js';

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
  /**
   * The photo to send if the customer asks to see this item, or null when the
   * shop has not uploaded one.
   *
   * Carried on the evidence rather than looked up later so the decision to
   * offer a picture rests on the same snapshot of the catalogue as every other
   * claim in the reply. The id itself is never shown to the model — it only
   * learns whether a photo exists, because "let me send you a picture" is a
   * promise, and a model that could name an image id would sooner or later
   * name one that does not exist.
   */
  photoId?: string | null;
  /**
   * Every price this item may be sold at, and the lowest one.
   *
   * Computed by the server from the shop's own settings before the model is
   * called. Optional only so the test files and the replay script that build
   * this by hand keep working; absent means one price and no negotiation.
   */
  ladder?: PriceLadder | null;
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
  /**
   * The lowest unit price, in pesewas, the assistant may agree to per product.
   *
   * A product absent from this map is not negotiable. The router consults it
   * directly rather than trusting anything the model said about it.
   */
  priceFloors: Map<string, number>;
  /**
   * Whether ANY product in this reply can be haggled over.
   *
   * When true the router stops waiving money-grounding failures, even in
   * autonomous mode. A wrong figure in an ordinary reply is a sentence a
   * customer queries; a wrong figure in a negotiation is a price the shop has
   * agreed to.
   */
  negotiable: boolean;
  /** Service ids that were actually supplied, for checking a booking. */
  serviceIds: Set<string>;
  /**
   * The exact instants, per service, that the assistant may agree to.
   *
   * Held as epoch milliseconds so a comparison never depends on how a date was
   * spelled. Computed from the diary before the model is called: a time that is
   * not in here was not free when the prompt was written, and the model has no
   * way to put it there.
   */
  allowedSlots: Map<string, Set<number>>;
}

/** A bookable service, as the assistant sees it. */
export interface EvidenceService {
  id: string;
  name: string;
  durationMinutes: number;
  price: number | null;
  /** Free times, soonest first. Already checked against the diary. */
  slots: Array<{ startsAt: Date; endsAt: Date }>;
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
  /** Absent for a business that does not take bookings, which is most of them. */
  services?: EvidenceService[];
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
  const priceFloors = new Map<string, number>();
  const serviceIds = new Set<string>();
  const allowedSlots = new Map<string, Set<number>>();

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

    // Every rung of the ladder, not just the list price. A shop running a
    // promotion has two legitimate prices for one item and a bulk tier adds a
    // third; without this the validator rejects the promotion price as
    // invented and the sale the owner is advertising never gets quoted.
    //
    // Nothing BETWEEN the rungs is added. That gap is the point: it is what
    // makes "how about GHS 43?" a figure the server can recognise as one it
    // never authorised.
    const unitPrices = product.ladder ? product.ladder.rungs : [product.price];

    for (const unitPrice of unitPrices) {
      for (const quantity of quantities) {
        const total = toMinorUnits(unitPrice * quantity);
        allowedAmounts.add(total);
        // Only list-price lines feed the basket sum. Summing a promotional
        // line with a list line would authorise a total for a basket nobody
        // could actually be quoted.
        if (quantity > 1 && unitPrice === product.price) lineTotals.push(total);
      }
    }

    if (product.ladder?.floor !== null && product.ladder?.floor !== undefined) {
      priceFloors.set(product.id, toMinorUnits(product.ladder.floor));
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
    // Every zone fee is allowed, not just the one for the area the customer
    // named. The validator's job is to prove a figure came from the shop's own
    // records, and all of these did; deciding WHICH one answers this particular
    // question is the model's job, and a wrong-but-real fee is caught by the
    // fact that it has to cite the zone it used.
    if (profile.deliveryZones && profile.deliveryZones.length > 0) {
      factKeys.add('deliveryZones');
      for (const zone of profile.deliveryZones) {
        allowedAmounts.add(toMinorUnits(zone.fee));
      }
    }
    if (profile.locationUrl) factKeys.add('locationUrl');
    if (profile.locationDescription) factKeys.add('locationDescription');
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

  for (const service of input.services ?? []) {
    serviceIds.add(service.id);
    if (service.price !== null) allowedAmounts.add(toMinorUnits(service.price));
    allowedSlots.set(service.id, new Set(service.slots.map((slot) => slot.startsAt.getTime())));
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
    priceFloors,
    negotiable: priceFloors.size > 0,
    serviceIds,
    allowedSlots,
  };
}
