import { describe, expect, it } from 'vitest';
import { composeReceipt, type ReceiptLines } from '../src/services/notifications/receipts.js';

/**
 * What a customer reads after paying.
 *
 * The receipt is the only thing they hold, so the tests below are mostly about
 * what it must never omit or imply: an outstanding balance stated plainly, a
 * reference they can paste into a complaint, and a length Meta will accept.
 */
function receipt(overrides: Partial<ReceiptLines> = {}): ReceiptLines {
  return {
    businessName: 'Mama Efua Provisions',
    amount: 180,
    reference: 'fdpay-9f2c7a1b4e6d8c0a',
    orderReference: 'ORD-0042',
    method: 'MOMO_MTN',
    paidAt: new Date('2026-09-16T14:05:00Z'),
    balance: 0,
    items: [{ name: 'Rice 5kg', quantity: 2, total: 160 }],
    ...overrides,
  };
}

describe('composeReceipt', () => {
  it('leads with the shop and the amount', () => {
    const text = composeReceipt(receipt());
    const lines = text.split('\n');
    expect(lines[0]).toBe('*Mama Efua Provisions*');
    // The amount is the only line anyone checks twice.
    expect(lines[1]).toContain('GHS 180.00');
  });

  it('names the network rather than the enum', () => {
    expect(composeReceipt(receipt())).toContain('MTN MoMo');
    expect(composeReceipt(receipt({ method: 'MOMO_VODAFONE' }))).toContain('Telecel Cash');
    expect(composeReceipt(receipt({ method: 'CARD' }))).toContain('Card');
  });

  it('states an outstanding balance plainly', () => {
    // A customer who still owes money and is not told finds out in an argument.
    const text = composeReceipt(receipt({ balance: 40 }));
    expect(text).toContain('Still to pay: GHS 40.00');
    expect(text).not.toContain('Paid in full');
  });

  it('says paid in full when it is', () => {
    expect(composeReceipt(receipt({ balance: 0 }))).toContain('Paid in full');
  });

  it('says nothing about a balance when there is no order to have one', () => {
    const text = composeReceipt(receipt({ balance: null, orderReference: null }));
    expect(text).not.toContain('Still to pay');
    expect(text).not.toContain('Paid in full');
    expect(text).not.toContain('Order:');
  });

  it('puts the reference last and on its own line', () => {
    const lines = composeReceipt(receipt()).split('\n');
    expect(lines.at(-1)).toBe('Ref: fdpay-9f2c7a1b4e6d8c0a');
  });

  it('writes the date the way a Ghanaian reads it, in Ghanaian time', () => {
    // Built by hand rather than via toLocaleString: the server's timezone is
    // whatever the host decided, and a receipt three hours out gets queried.
    expect(composeReceipt(receipt())).toContain('Date: 16 Sep 2026, 14:05');
  });

  it('lists the items bought', () => {
    expect(composeReceipt(receipt())).toContain('2 × Rice 5kg — GHS 160.00');
  });

  it('truncates a long item list rather than dropping the total', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `Product ${i}`,
      quantity: 1,
      total: 10,
    }));
    const text = composeReceipt(receipt({ items }));
    expect(text).toContain('…and 12 more');
    // The parts that matter survive the truncation.
    expect(text).toContain('GHS 180.00');
  });

  it('never exceeds the caption length Meta accepts', () => {
    // Over 1024 and Meta rejects the whole message, losing the receipt entirely.
    const items = Array.from({ length: 200 }, (_, i) => ({
      name: `A very long product name number ${i} that goes on and on`,
      quantity: 3,
      total: 1234.56,
    }));
    const text = composeReceipt(
      receipt({ items, businessName: 'A'.repeat(200), reference: 'B'.repeat(200) }),
    );
    expect(text.length).toBeLessThanOrEqual(1024);
  });
});
