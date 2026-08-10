import { describe, it, expect } from 'vitest';
import {
  PAYMENT_CONFIDENCE_RANK,
  isAttested,
  netAttested,
  type AttestablePayment,
} from '@flowdesk/shared';

function payment(over: Partial<AttestablePayment> = {}): AttestablePayment {
  return {
    amount: 100,
    direction: 'IN',
    confidence: 'SELLER_ATTESTED',
    voidedAt: null,
    ...over,
  };
}

describe('PAYMENT_CONFIDENCE_RANK', () => {
  it('orders the ladder from weakest to strongest', () => {
    expect(PAYMENT_CONFIDENCE_RANK.CLAIMED).toBeLessThan(PAYMENT_CONFIDENCE_RANK.SELLER_ATTESTED);
    expect(PAYMENT_CONFIDENCE_RANK.SELLER_ATTESTED).toBeLessThan(PAYMENT_CONFIDENCE_RANK.TELCO_MATCHED);
    expect(PAYMENT_CONFIDENCE_RANK.TELCO_MATCHED).toBeLessThan(PAYMENT_CONFIDENCE_RANK.GATEWAY_CONFIRMED);
  });
});

describe('isAttested', () => {
  it('rejects a customer claim, which is the whole point of the ladder', () => {
    expect(isAttested(payment({ confidence: 'CLAIMED' }))).toBe(false);
  });

  it('accepts a seller attestation', () => {
    expect(isAttested(payment({ confidence: 'SELLER_ATTESTED' }))).toBe(true);
  });

  it('accepts every tier above a seller attestation', () => {
    expect(isAttested(payment({ confidence: 'TELCO_MATCHED' }))).toBe(true);
    expect(isAttested(payment({ confidence: 'GATEWAY_CONFIRMED' }))).toBe(true);
  });

  it('rejects a voided payment however strong its tier', () => {
    expect(isAttested(payment({ confidence: 'GATEWAY_CONFIRMED', voidedAt: new Date() }))).toBe(false);
  });

  it('treats an ISO string voidedAt as voided, since JSON has no Date', () => {
    expect(isAttested(payment({ voidedAt: '2026-08-10T09:00:00.000Z' }))).toBe(false);
  });
});

describe('netAttested', () => {
  it('is zero for no payments', () => {
    expect(netAttested([])).toBe(0);
  });

  it('ignores claims entirely', () => {
    expect(netAttested([payment({ amount: 100 }), payment({ amount: 50, confidence: 'CLAIMED' })])).toBe(100);
  });

  it('subtracts an attested refund', () => {
    expect(netAttested([payment({ amount: 100 }), payment({ amount: 30, direction: 'OUT' })])).toBe(70);
  });

  it('ignores a voided refund', () => {
    expect(
      netAttested([payment({ amount: 100 }), payment({ amount: 30, direction: 'OUT', voidedAt: new Date() })]),
    ).toBe(100);
  });

  it('can go negative, because an over-refund is real information', () => {
    expect(netAttested([payment({ amount: 20 }), payment({ amount: 50, direction: 'OUT' })])).toBe(-30);
  });
});
