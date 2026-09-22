import { prisma } from '../../config/database.js';
import { features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  commissionPercentFor,
  createSubaccount,
  listSettlementDestinations,
  resolveAccountName,
  updateSubaccount,
  type SettlementDestination,
} from '../../services/billing/paystack-connect.js';

/**
 * Where a shop gets paid.
 *
 * One screen's worth of state, and the single thing standing between a shop and
 * being able to take money. It is deliberately short: a network, a number, and
 * a name read back to them. Anything more and it does not get finished, and a
 * shop that cannot take payment has no reason to keep the rest of the product.
 */

export interface PayoutStatus {
  connected: boolean;
  /** Masked. The full number is never returned once stored. */
  accountNumber: string | null;
  accountName: string | null;
  bankCode: string | null;
  bankName: string | null;
  connectedAt: Date | null;
  /** What Flowdesk keeps per payment, as a percentage. */
  commissionPercent: number;
  /** False when this deployment has no Paystack keys at all. */
  available: boolean;
}

export async function listDestinations(): Promise<SettlementDestination[]> {
  if (!features.billing) return [];
  return listSettlementDestinations();
}

/**
 * Shows the last four digits and nothing else.
 *
 * A settlement number is not a secret in the way a password is, but it is one
 * of the two things needed to redirect a shop's takings, and a staff account
 * with settings access does not need to read it back to confirm it is right —
 * the resolved account name does that job better.
 */
function maskAccount(accountNumber: string | null): string | null {
  if (!accountNumber) return null;
  if (accountNumber.length <= 4) return '•'.repeat(accountNumber.length);
  return `${'•'.repeat(Math.max(accountNumber.length - 4, 2))}${accountNumber.slice(-4)}`;
}

export async function getPayoutStatus(businessId: string): Promise<PayoutStatus> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      paystackSubaccountCode: true,
      payoutAccountNumber: true,
      payoutAccountName: true,
      payoutBankCode: true,
      payoutConnectedAt: true,
      commissionPercent: true,
    },
  });

  if (!business) throw new NotFoundError('Business not found');

  const commission = commissionPercentFor(
    business.commissionPercent === null ? null : Number(business.commissionPercent),
  );

  let bankName: string | null = null;
  if (business.payoutBankCode && features.billing) {
    const destinations = await listSettlementDestinations();
    bankName = destinations.find((d) => d.code === business.payoutBankCode)?.name ?? null;
  }

  return {
    connected: Boolean(business.paystackSubaccountCode),
    accountNumber: maskAccount(business.payoutAccountNumber),
    accountName: business.payoutAccountName,
    bankCode: business.payoutBankCode,
    bankName,
    connectedAt: business.payoutConnectedAt,
    commissionPercent: commission,
    available: features.billing,
  };
}

export interface ConnectPayoutInput {
  bankCode: string;
  accountNumber: string;
}

/**
 * Connects, or re-points, where a shop is settled.
 *
 * The account is resolved with Paystack first and the RESOLVED name is what is
 * stored. A shop owner reading "KWAME MENSAH" back knows instantly whether the
 * number they typed is theirs; a shop owner reading back the digits they just
 * typed learns nothing, because they will read what they meant to type.
 */
export async function connectPayout(
  businessId: string,
  input: ConnectPayoutInput,
): Promise<PayoutStatus> {
  if (!features.billing) {
    throw new ValidationError('Payments are not configured on this deployment.');
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      paystackSubaccountCode: true,
      commissionPercent: true,
    },
  });

  if (!business) throw new NotFoundError('Business not found');

  const accountNumber = input.accountNumber.replace(/\s+/g, '');
  if (!/^\d{6,20}$/.test(accountNumber)) {
    throw new ValidationError('That does not look like a momo number or account number.');
  }

  const destinations = await listSettlementDestinations();
  if (destinations.length > 0 && !destinations.some((d) => d.code === input.bankCode)) {
    throw new ValidationError('Pick a network or bank from the list.');
  }

  const resolved = await resolveAccountName(accountNumber, input.bankCode);
  if (!resolved) {
    throw new ValidationError(
      'That number could not be verified with the network. Check the digits and the network you picked.',
    );
  }

  const commission = commissionPercentFor(
    business.commissionPercent === null ? null : Number(business.commissionPercent),
  );

  let subaccountCode = business.paystackSubaccountCode;

  if (subaccountCode) {
    await updateSubaccount(subaccountCode, {
      bankCode: input.bankCode,
      accountNumber,
      businessName: business.name,
    });
  } else {
    const created = await createSubaccount({
      businessName: business.name,
      bankCode: input.bankCode,
      accountNumber,
      commissionPercent: commission,
      contactEmail: business.email,
      contactPhone: business.phone,
      businessId: business.id,
    });
    subaccountCode = created.subaccountCode;
  }

  await prisma.business.update({
    where: { id: businessId },
    data: {
      paystackSubaccountCode: subaccountCode,
      payoutBankCode: input.bankCode,
      payoutAccountNumber: accountNumber,
      payoutAccountName: resolved.accountName,
      payoutConnectedAt: new Date(),
    },
  });

  logger.info({ businessId, subaccountCode }, 'Shop payout destination connected');

  return getPayoutStatus(businessId);
}
