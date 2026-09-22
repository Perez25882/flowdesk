import { describe, expect, it } from 'vitest';
import { ASSISTANT_CONTRACT_VERSION, IntentType, type AssistantDecision } from '@flowdesk/shared';
import { bookingOfferStatus } from '../src/services/assistant/booking-offer.js';
import { buildEvidenceSet } from '../src/services/assistant/evidence.js';

/**
 * The assistant may only agree to a time the server already established was
 * free. This is that check — the half of the no-double-booking promise the
 * application owns. The other half is a database exclusion constraint, which
 * nothing here can reach.
 */

const TUESDAY_10 = new Date('2026-09-22T10:00:00.000Z');
const TUESDAY_11 = new Date('2026-09-22T11:00:00.000Z');

const evidence = buildEvidenceSet({
  products: [],
  services: [
    {
      id: 'svc_consult',
      name: 'Consultation',
      durationMinutes: 30,
      price: 150,
      slots: [
        { startsAt: TUESDAY_10, endsAt: new Date('2026-09-22T10:30:00.000Z') },
        { startsAt: TUESDAY_11, endsAt: new Date('2026-09-22T11:30:00.000Z') },
      ],
    },
    { id: 'svc_full', name: 'Full day', durationMinutes: 480, price: null, slots: [] },
  ],
  profile: null,
  openOrders: [],
  mentionedQuantities: [],
  businessPhones: [],
});

function decisionFor(overrides: Partial<AssistantDecision> = {}): AssistantDecision {
  return {
    version: ASSISTANT_CONTRACT_VERSION,
    intent: IntentType.INQUIRY,
    confidence: 0.95,
    language: 'gh_en',
    sentiment: 'neutral',
    entities: { products: [], orderReferences: [], deliveryArea: null },
    answer: { canAnswer: true, text: 'Tuesday at 10 then.', groundedOn: [] },
    clarification: { needed: false, missing: [] },
    order: { isOrder: false, complete: false },
    escalate: { needed: false, reason: null },
    priceOffer: null,
    booking: null,
    ...overrides,
  };
}

describe('bookingOfferStatus', () => {
  it('is "none" when the reply books nothing', () => {
    expect(bookingOfferStatus(decisionFor(), evidence)).toBe('none');
  });

  it('authorises a time that was offered', () => {
    const decision = decisionFor({
      booking: { serviceId: 'svc_consult', startsAt: '2026-09-22T10:00:00.000Z' },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('authorised');
  });

  it('accepts the same instant spelled differently', () => {
    // The model echoes what it was given, but not always to the millisecond.
    // Comparing strings would refuse a correct booking.
    const decision = decisionFor({
      booking: { serviceId: 'svc_consult', startsAt: '2026-09-22T10:00:00Z' },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('authorised');
  });

  it('refuses a time that was never offered', () => {
    const decision = decisionFor({
      booking: { serviceId: 'svc_consult', startsAt: '2026-09-22T10:15:00.000Z' },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('refused');
  });

  it('refuses a service that has nothing free at all', () => {
    const decision = decisionFor({
      booking: { serviceId: 'svc_full', startsAt: '2026-09-22T10:00:00.000Z' },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('refused');
  });

  it('refuses a service the model invented', () => {
    const decision = decisionFor({
      booking: { serviceId: 'svc_nope', startsAt: '2026-09-22T10:00:00.000Z' },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('refused');
  });

  it('refuses an unparseable time rather than booking the epoch', () => {
    for (const startsAt of ['tomorrow at ten', '', 'Tuesday']) {
      const decision = decisionFor({ booking: { serviceId: 'svc_consult', startsAt } });
      expect(bookingOfferStatus(decision, evidence)).toBe('refused');
    }
  });

  it("does not let one service's free time authorise another's", () => {
    // A clinic with a free consultation slot at 10 and a fully booked theatre
    // must not have the theatre booked at 10 because the clinic was free.
    const decision = decisionFor({
      booking: { serviceId: 'svc_full', startsAt: TUESDAY_11.toISOString() },
    });
    expect(bookingOfferStatus(decision, evidence)).toBe('refused');
  });
});
