import { describe, expect, it } from 'vitest';
import {
  isPaymentLinkReference,
  methodFromCharge,
} from '../src/modules/payments/payment-links.service.js';
import { commissionPercentFor } from '../src/services/billing/paystack-connect.js';

/**
 * The parts of the payment-link flow that decide where money is filed.
 *
 * All three are small and all three are the kind of thing that is wrong for
 * months without anyone noticing, because the failure looks like correct
 * behaviour until someone reconciles against a momo statement.
 */

describe('isPaymentLinkReference', () => {
  it('claims the references this module generates', () => {
    expect(isPaymentLinkReference('fdpay-9f2c7a1b4e6d8c0a2b4c6d8e')).toBe(true);
  });

  it('leaves a subscription charge to the billing path', () => {
    // This is the one that matters. A false positive here would settle a shop's
    // own subscription payment into their customer ledger as a sale; a false
    // negative would read a customer's GHS 40 as a plan renewal.
    expect(isPaymentLinkReference('T123456789')).toBe(false);
    expect(isPaymentLinkReference('sub_renewal_abc')).toBe(false);
    expect(isPaymentLinkReference('')).toBe(false);
    expect(isPaymentLinkReference(null)).toBe(false);
    expect(isPaymentLinkReference(undefined)).toBe(false);
  });

  it('is not fooled by a reference that merely contains the prefix', () => {
    expect(isPaymentLinkReference('not-fdpay-123')).toBe(false);
  });
});

describe('methodFromCharge', () => {
  it('names the network rather than the category', () => {
    // "mobile money" is useless to an owner reconciling against a statement —
    // they need to know which wallet to open.
    expect(methodFromCharge('mobile_money', 'MTN')).toBe('MOMO_MTN');
    expect(methodFromCharge('mobile_money', 'AirtelTigo')).toBe('MOMO_AIRTELTIGO');
  });

  it('files Telecel and Vodafone in the same bucket', () => {
    // Telecel bought Vodafone Ghana in 2023 and Paystack returned both names
    // through the transition. Splitting them would split a shop's history.
    expect(methodFromCharge('mobile_money', 'Telecel')).toBe('MOMO_VODAFONE');
    expect(methodFromCharge('mobile_money', 'Vodafone')).toBe('MOMO_VODAFONE');
    expect(methodFromCharge('mobile_money', 'VODAFONE CASH')).toBe('MOMO_VODAFONE');
  });

  it('handles a card and a bank transfer', () => {
    expect(methodFromCharge('card', 'visa')).toBe('CARD');
    expect(methodFromCharge('bank', null)).toBe('BANK_TRANSFER');
    expect(methodFromCharge('bank_transfer', null)).toBe('BANK_TRANSFER');
  });

  it('falls back rather than guessing a network it does not recognise', () => {
    expect(methodFromCharge('mobile_money', 'Some New Wallet')).toBe('OTHER');
    expect(methodFromCharge('mobile_money', null)).toBe('OTHER');
    expect(methodFromCharge('ussd', null)).toBe('OTHER');
    expect(methodFromCharge(null, null)).toBe('OTHER');
  });
});

describe('commissionPercentFor', () => {
  it('uses the business override when there is one', () => {
    expect(commissionPercentFor(0)).toBe(0);
    expect(commissionPercentFor(2.5)).toBe(2.5);
  });

  it('falls back to the platform default', () => {
    // Whatever the deployment's default is, a null override must not become 0 —
    // a silently free tier is a revenue bug that looks like nothing at all.
    expect(commissionPercentFor(null)).toBeGreaterThan(0);
  });

  it('refuses a percentage Paystack would reject', () => {
    // percentage_charge is what the MAIN account keeps. A value above 100 would
    // be rejected by Paystack; a negative one is nonsense either way.
    expect(commissionPercentFor(150)).toBe(100);
    expect(commissionPercentFor(-5)).toBe(0);
  });
});
