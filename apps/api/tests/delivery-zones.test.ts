import { describe, expect, it } from 'vitest';
import { findDeliveryZone, type DeliveryZone } from '@flowdesk/shared';
import { renderDeliveryZones } from '../src/services/assistant/prompt.js';

/**
 * Matching a place a customer typed to a fee the owner set.
 *
 * The bar is: generous about spelling, strict about meaning. A wrong-but-real
 * fee reaching a customer is the failure this whole grounding apparatus exists
 * to prevent, and "close enough" matching is how one gets through.
 */
const zones: DeliveryZone[] = [
  { region: 'Greater Accra', town: 'Tema', area: null, fee: 20 },
  { region: 'Greater Accra', town: 'Tema', area: 'Community 1', fee: 15 },
  { region: 'Greater Accra', town: 'Kasoa', area: null, fee: 35, eta: '1-2 days' },
  { region: 'Greater Accra', town: 'East Legon', area: null, fee: 0 },
];

describe('findDeliveryZone', () => {
  it('matches a bare town', () => {
    expect(findDeliveryZone(zones, 'Tema')?.fee).toBe(20);
    expect(findDeliveryZone(zones, 'kasoa')?.fee).toBe(35);
  });

  it('prefers the more specific area over the town it sits in', () => {
    // The whole point of three levels. Quoting 20 to someone who said
    // Community 1 overcharges them by a third.
    expect(findDeliveryZone(zones, 'Tema Community 1')?.fee).toBe(15);
  });

  it('understands how people actually write Tema addresses', () => {
    expect(findDeliveryZone(zones, 'tema comm 1')?.fee).toBe(15);
    expect(findDeliveryZone(zones, 'Tema, Community 1')?.fee).toBe(15);
  });

  it('does not answer a bare town with an area-specific price', () => {
    // "Tema" must not silently get the Community 1 rate — the customer has not
    // said they are in Community 1.
    const match = findDeliveryZone(zones, 'tema');
    expect(match?.area).toBeNull();
    expect(match?.fee).toBe(20);
  });

  it('keeps free delivery as a real answer rather than a missing one', () => {
    const match = findDeliveryZone(zones, 'East Legon');
    expect(match).not.toBeNull();
    expect(match?.fee).toBe(0);
  });

  it('returns null for a place the shop never priced', () => {
    // Null is the assistant's cue to ask the owner. Anything else here would be
    // the system inventing a delivery charge.
    expect(findDeliveryZone(zones, 'Kumasi')).toBeNull();
    expect(findDeliveryZone(zones, '')).toBeNull();
    expect(findDeliveryZone(zones, '   ')).toBeNull();
  });

  it('returns null when the shop has set no zones at all', () => {
    expect(findDeliveryZone([], 'Tema')).toBeNull();
    expect(findDeliveryZone(undefined, 'Tema')).toBeNull();
  });
});

describe('renderDeliveryZones', () => {
  it('reads as a price list, with free stated as free', () => {
    const rendered = renderDeliveryZones(zones);
    expect(rendered).toContain('Tema (Greater Accra): GHS 20.00');
    expect(rendered).toContain('Tema (Greater Accra) — Community 1: GHS 15.00');
    expect(rendered).toContain('Kasoa (Greater Accra): GHS 35.00, 1-2 days');
    // "GHS 0.00" invites a model to write "zero cedis"; "free" is the sentence
    // a shopkeeper would actually say.
    expect(rendered).toContain('East Legon (Greater Accra): free');
  });
});
