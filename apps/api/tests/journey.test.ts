import { describe, expect, it } from 'vitest';
import {
  buildFunnel,
  positionFor,
  worstDropOff,
  type JourneyInput,
  type JourneyPosition,
} from '../src/modules/customers/journey.js';

const NOW = new Date('2026-09-17T12:00:00Z');

function input(overrides: Partial<JourneyInput> = {}): JourneyInput {
  return {
    customerId: 'c1',
    intents: [],
    ordersPlaced: 0,
    paymentLinksSent: 0,
    paymentsSettled: 0,
    lastActivityAt: NOW,
    ...overrides,
  };
}

function at(stage: JourneyPosition['stage'], count: number): JourneyPosition[] {
  return Array.from({ length: count }, (_, i) => ({
    customerId: `${stage}-${i}`,
    stage,
    daysStalled: 0,
    complete: stage === 'paid',
  }));
}

describe('positionFor', () => {
  it('reports the furthest point reached, not the latest event', () => {
    // Paid, then asked another question. Still a paying customer.
    const result = positionFor(
      input({ intents: ['INQUIRY'], ordersPlaced: 1, paymentLinksSent: 1, paymentsSettled: 1 }),
      NOW,
    );
    expect(result.stage).toBe('paid');
    expect(result.complete).toBe(true);
  });

  it('separates a greeting from a question', () => {
    expect(positionFor(input({ intents: ['GREETING'] }), NOW).stage).toBe('greeted');
    expect(positionFor(input({ intents: ['GREETING', 'INQUIRY'] }), NOW).stage).toBe('asked');
  });

  it('counts wanting to buy even when no order was ever raised', () => {
    // The damning case: they said they wanted it and nothing was written down.
    const result = positionFor(input({ intents: ['INQUIRY', 'ORDER'], ordersPlaced: 0 }), NOW);
    expect(result.stage).toBe('wanted');
    expect(result.complete).toBe(false);
  });

  it('counts the days a conversation has been sitting still', () => {
    const result = positionFor(
      input({ intents: ['ORDER'], lastActivityAt: new Date('2026-09-10T12:00:00Z') }),
      NOW,
    );
    expect(result.daysStalled).toBe(7);
  });

  it('has no stall figure for a customer who has never done anything', () => {
    expect(positionFor(input({ lastActivityAt: null }), NOW).daysStalled).toBeNull();
  });
});

describe('buildFunnel', () => {
  it('counts reach cumulatively, so the numbers only fall', () => {
    const funnel = buildFunnel([...at('greeted', 10), ...at('asked', 6), ...at('paid', 4)]);

    expect(funnel.map((step) => step.reached)).toEqual([20, 10, 4, 4, 4]);
    expect(funnel.map((step) => step.stoppedHere)).toEqual([10, 6, 0, 0, 4]);
  });

  it('shows a month where everybody paid as full reach, not a collapse', () => {
    const funnel = buildFunnel(at('paid', 12));
    expect(funnel.every((step) => step.reached === 12)).toBe(true);
  });

  it('returns every stage even with no customers at all', () => {
    expect(buildFunnel([]).map((s) => s.stage)).toEqual([
      'greeted',
      'asked',
      'wanted',
      'billed',
      'paid',
    ]);
  });
});

describe('worstDropOff', () => {
  it('says nothing at all on thin traffic', () => {
    // Three people leaving is not a 70% problem, it is three people.
    expect(worstDropOff(buildFunnel([...at('greeted', 7), ...at('paid', 3)]))).toBeNull();
  });

  it('names the biggest fall, not the fullest step', () => {
    // 'greeted' always holds the most people. The loss is elsewhere.
    const funnel = buildFunnel([
      ...at('greeted', 5),
      ...at('asked', 10),
      ...at('wanted', 30),
      ...at('paid', 5),
    ]);

    const worst = worstDropOff(funnel);
    expect(worst).not.toBeNull();
    expect(worst!.from).toBe('wanted');
    expect(worst!.to).toBe('billed');
    expect(worst!.lost).toBe(30);
  });

  it('is null when nobody drops off anywhere', () => {
    expect(worstDropOff(buildFunnel(at('paid', 40)))).toBeNull();
  });
});
