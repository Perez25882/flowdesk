import type { AssistantDecision } from '@flowdesk/shared';
import type { EvidenceSet } from './evidence.js';

/**
 * Whether a time the assistant just offered is a time that actually exists.
 *
 * The same shape as the price floor, for the same reason. A wrong sentence is
 * a sentence a customer queries. A wrong appointment is two people arriving at
 * a clinic for the same slot, and the shop finds out when the second one is
 * standing at the desk.
 *
 * So the model does not decide when the business is free. The server computes
 * the free slots before the model is called, puts them in the prompt, and
 * checks the one that comes back against the same list. A time that is not on
 * it is refused, in every mode — autonomy is the owner saying "answer without
 * me", never "put whoever you like in my diary".
 *
 * There is a second gate underneath this one, in the database, and the two are
 * not redundant. This stops the shop OFFERING a time it cannot honour. The
 * exclusion constraint stops a time offered twice in the same second being
 * TAKEN twice. Neither covers the other's case.
 */

export type BookingOfferStatus = 'none' | 'authorised' | 'refused';

export function bookingOfferStatus(
  decision: AssistantDecision,
  evidence: EvidenceSet,
): BookingOfferStatus {
  const offer = decision.booking;
  if (!offer) return 'none';

  // A booking for a service that was never put in front of the model. The id
  // is invented, so there is nothing to check the time against.
  if (!evidence.serviceIds.has(offer.serviceId)) return 'refused';

  const startsAt = new Date(offer.startsAt);
  if (Number.isNaN(startsAt.getTime())) return 'refused';

  // Compared as an exact instant, normalised through Date rather than by
  // string equality: the model may echo `2026-09-22T14:30:00Z` where the
  // server wrote `2026-09-22T14:30:00.000Z`, and those are the same moment.
  const offered = startsAt.getTime();
  const free = evidence.allowedSlots.get(offer.serviceId);
  if (!free) return 'refused';

  return free.has(offered) ? 'authorised' : 'refused';
}
