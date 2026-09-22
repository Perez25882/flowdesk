/**
 * What a product may be sold for, and the lowest the assistant may go.
 *
 * Negotiation is the feature this exists for, and it is the most dangerous
 * thing in the assistant. Every other mistake it can make is a wrong sentence
 * that a customer reads and queries. A price is different: once the assistant
 * says "okay, GHS 40", the shop has agreed to GHS 40, and the owner finds out
 * when the money arrives short.
 *
 * So the floor is not something the model is asked to respect. The model
 * proposes a price; this module decides whether that price exists. The set of
 * prices that exist is small, finite and computed by the server before the
 * model is called:
 *
 *   list price  →  promotion price  →  bulk tier price  →  floor
 *
 * Anything else is not a price, it is a number the model wrote. The router
 * refuses to send it.
 *
 * Amounts here are in cedis as `number`, converted to pesewas at the boundary
 * by the evidence builder. Rounding is to the pesewa, always downward for a
 * discount — a rounding rule that ever favours the shop turns "10% off" into
 * "10% off, plus a pesewa" and a customer who checks the arithmetic is right
 * and the shop is wrong.
 */

export interface TierInput {
  minQuantity: number;
  percentOff: number;
}

export interface LadderInput {
  price: number;
  floorPrice?: number | null;
  discountPercent?: number | null;
  discountLabel?: string | null;
  discountEndsAt?: Date | null;
  tiers?: TierInput[];
  /** The shop's master switch. With it off there is no floor and no haggling. */
  bargainingEnabled: boolean;
}

export interface PriceLadder {
  /** The price on the shelf, before anything is taken off. */
  listPrice: number;
  /** After a live promotion. Equals `listPrice` when none is running. */
  promoPrice: number;
  /** The promotion's name, when one is running and has not expired. */
  promoLabel: string | null;
  /** Percentage currently off, or null. */
  promoPercent: number | null;
  /**
   * The lowest unit price the assistant may agree to, or null when this item is
   * not negotiable. Never below the promotion price by accident: a floor above
   * the promotion means the promotion IS the floor.
   */
  floor: number | null;
  /** Every unit price that exists, cheapest first. Nothing between the rungs. */
  rungs: number[];
  tiers: Array<{ minQuantity: number; percentOff: number; unitPrice: number }>;
}

/** Two decimal places, rounded down, so a discount is never a pesewa short. */
function toPesewaFloor(value: number): number {
  return Math.floor(value * 100 + 1e-6) / 100;
}

function applyPercent(price: number, percent: number): number {
  return toPesewaFloor(price * (1 - percent / 100));
}

/** Whether a promotion is running right now. */
export function promotionIsLive(
  discountPercent: number | null | undefined,
  discountEndsAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (discountPercent === null || discountPercent === undefined) return false;
  if (discountPercent < 1 || discountPercent > 90) return false;
  // An expiry that has passed is not a promotion. Checked at read time rather
  // than swept by a job, so a promotion ends the second it says it will even if
  // nothing has run since.
  if (discountEndsAt && discountEndsAt.getTime() <= now.getTime()) return false;
  return true;
}

export function buildLadder(input: LadderInput, now: Date = new Date()): PriceLadder {
  const listPrice = toPesewaFloor(input.price);

  const live = promotionIsLive(input.discountPercent, input.discountEndsAt, now);
  const promoPercent = live ? (input.discountPercent as number) : null;
  const promoPrice = promoPercent === null ? listPrice : applyPercent(listPrice, promoPercent);

  // Tiers come off the price actually in force, so a promotion and a bulk tier
  // compound. That is what an owner setting both of them means, and the
  // alternative — the better of the two — silently ignores one of the things
  // they turned on.
  const tiers = (input.tiers ?? [])
    .filter((t) => t.minQuantity >= 2 && t.percentOff >= 1 && t.percentOff <= 90)
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((t) => ({
      minQuantity: t.minQuantity,
      percentOff: t.percentOff,
      unitPrice: applyPercent(promoPrice, t.percentOff),
    }));

  let floor: number | null = null;

  if (input.bargainingEnabled && input.floorPrice !== null && input.floorPrice !== undefined) {
    const stated = toPesewaFloor(input.floorPrice);
    // A floor above the price currently in force is not a floor, it is a
    // no-haggle sign. Clamping rather than rejecting, because an owner who
    // sets a floor of 40 and then runs a 50% promotion has not made a mistake
    // worth failing a request over — they have made the promotion the floor.
    floor = Math.min(stated, promoPrice, ...tiers.map((t) => t.unitPrice));
    if (floor <= 0) floor = null;
  }

  const rungs = new Set<number>([listPrice, promoPrice]);
  for (const tier of tiers) rungs.add(tier.unitPrice);
  if (floor !== null) rungs.add(floor);

  return {
    listPrice,
    promoPrice,
    promoLabel: live ? (input.discountLabel?.trim() || null) : null,
    promoPercent,
    floor,
    rungs: [...rungs].sort((a, b) => a - b),
    tiers,
  };
}

/**
 * The price a given quantity actually costs per unit, before any haggling.
 *
 * The highest tier the quantity qualifies for wins. Ordering matters: tiers are
 * sorted ascending by `minQuantity` in `buildLadder`, so the last match is the
 * deepest discount the customer has earned.
 */
export function unitPriceForQuantity(ladder: PriceLadder, quantity: number): number {
  let price = ladder.promoPrice;

  for (const tier of ladder.tiers) {
    if (quantity >= tier.minQuantity) price = tier.unitPrice;
  }

  return price;
}

/**
 * Whether an offered unit price is one the shop has authorised.
 *
 * The rule the whole feature rests on, and the reason it is a pure function
 * with no I/O: it is called from the router on every reply, it has to be
 * trivially testable, and it must not be possible for a slow query or a cache
 * to make it answer differently for the same inputs.
 *
 * Anything at or above the price for that quantity is fine — a customer who is
 * happy to pay list price after a tier applies is not a problem. Below it is
 * allowed only down to the floor, and only when the shop set one.
 */
export function offerIsAuthorised(
  ladder: PriceLadder,
  quantity: number,
  offeredUnitPrice: number,
): boolean {
  if (!Number.isFinite(offeredUnitPrice) || offeredUnitPrice <= 0) return false;

  const standard = unitPriceForQuantity(ladder, quantity);
  // Compared in pesewas. Cedis are floats, and 0.1 + 0.2 is why a floor of
  // 40.30 would otherwise reject an offer of exactly 40.30.
  const offered = Math.round(offeredUnitPrice * 100);

  if (offered >= Math.round(standard * 100)) return true;
  if (ladder.floor === null) return false;

  return offered >= Math.round(ladder.floor * 100);
}
