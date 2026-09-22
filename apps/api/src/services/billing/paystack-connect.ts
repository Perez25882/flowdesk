import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { paystackRequest } from './paystack.js';

/**
 * Taking money on a shop's behalf, without ever holding it.
 *
 * Flowdesk is the Paystack merchant and every shop is a subaccount. Paystack
 * performs the split at settlement: the shop's share goes to the shop's own
 * momo wallet or bank account, and Flowdesk's commission goes to Flowdesk. No
 * customer money passes through a Flowdesk-controlled balance at any point,
 * which is what keeps this a software product rather than one that needs a
 * payment services licence.
 *
 * The other half of that design is that no card number, momo PIN or OTP ever
 * reaches this API. The customer is handed a Paystack-hosted URL and completes
 * the charge there; what comes back is a webhook and a reference.
 */

/**
 * The share Flowdesk keeps of each customer payment, as a percentage.
 *
 * `percentage_charge` on a Paystack subaccount is what the MAIN account
 * retains — which is this, not the shop's share. Getting that backwards would
 * settle 99% to Flowdesk and 1% to the shop, so it is worth naming plainly.
 */
export function commissionPercentFor(businessOverride: number | null): number {
  const percent = businessOverride ?? env.PLATFORM_COMMISSION_PERCENT;
  // Paystack rejects anything outside 0–100, and a commission above a few
  // percent is a pricing mistake rather than a configuration one.
  return Math.min(Math.max(percent, 0), 100);
}

export interface SettlementDestination {
  name: string;
  slug: string;
  /** Passed back as `settlement_bank`. Never hardcoded — see `listSettlementDestinations`. */
  code: string;
  type: string;
}

/**
 * Where a shop can be paid out to, fetched live from Paystack.
 *
 * Deliberately not a constant in this file. Vodafone Cash became Telecel Cash
 * and a hardcoded list would have shown the wrong name to every Ghanaian shop
 * for a year; new banks and wallets appear without asking us. The list is
 * Paystack's, so it is right by construction.
 */
export async function listSettlementDestinations(): Promise<SettlementDestination[]> {
  const [mobileMoney, banks] = await Promise.all([
    fetchDestinations('mobile_money'),
    fetchDestinations('ghipss'),
  ]);

  // Mobile money first: it is how the overwhelming majority of these shops are
  // actually paid, and making an owner scroll past forty banks to find MTN is
  // the kind of ordering that gets a setup abandoned halfway.
  return [...mobileMoney, ...banks];
}

async function fetchDestinations(type: 'mobile_money' | 'ghipss'): Promise<SettlementDestination[]> {
  try {
    const response = await paystackRequest<
      Array<{ name: string; slug: string; code: string; type: string; active?: boolean }>
    >(`/bank?country=ghana&currency=GHS&type=${type}&perPage=100`, { method: 'GET' });

    return (response.data ?? [])
      .filter((entry) => entry.active !== false)
      .map((entry) => ({
        name: entry.name,
        slug: entry.slug,
        code: entry.code,
        type: entry.type,
      }));
  } catch (error: unknown) {
    logger.error({ error, type }, 'Could not load settlement destinations from Paystack');
    return [];
  }
}

export interface ResolvedAccount {
  accountName: string;
  accountNumber: string;
}

/**
 * Asks Paystack whose account a number belongs to.
 *
 * Run before the subaccount is created, and the resolved name is what gets
 * stored and shown back. An owner who mistypes one digit of their momo number
 * otherwise finds out weeks later, when the first settlement has already gone
 * to a stranger and cannot be recalled.
 */
export async function resolveAccountName(
  accountNumber: string,
  bankCode: string,
): Promise<ResolvedAccount | null> {
  try {
    const response = await paystackRequest<{ account_name: string; account_number: string }>(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { method: 'GET' },
    );

    if (!response.status || !response.data?.account_name) return null;

    return {
      accountName: response.data.account_name,
      accountNumber: response.data.account_number,
    };
  } catch (error: unknown) {
    // A resolve failure is usually "no such account", which is information the
    // owner needs rather than an outage — the caller turns it into a message.
    logger.warn({ error, bankCode }, 'Paystack could not resolve a settlement account');
    return null;
  }
}

export interface SubaccountResult {
  subaccountCode: string;
  accountName: string;
}

/**
 * Creates the split destination for one shop.
 *
 * `percentage_charge` is Flowdesk's share. `settlement_bank` is a code from
 * `listSettlementDestinations`, never a name — Paystack matches on the code and
 * silently accepts nothing else.
 */
export async function createSubaccount(params: {
  businessName: string;
  bankCode: string;
  accountNumber: string;
  commissionPercent: number;
  contactEmail?: string | null;
  contactPhone?: string | null;
  businessId: string;
}): Promise<SubaccountResult> {
  const response = await paystackRequest<{ subaccount_code: string; account_name?: string }>(
    '/subaccount',
    {
      method: 'POST',
      body: JSON.stringify({
        business_name: params.businessName,
        settlement_bank: params.bankCode,
        account_number: params.accountNumber,
        percentage_charge: params.commissionPercent,
        ...(params.contactEmail ? { primary_contact_email: params.contactEmail } : {}),
        ...(params.contactPhone ? { primary_contact_phone: params.contactPhone } : {}),
        // Carried so a Paystack dashboard row can be traced back to a tenant
        // without a lookup table nobody remembers to keep.
        metadata: JSON.stringify({ flowdeskBusinessId: params.businessId }),
      }),
    },
  );

  const code = response.data?.subaccount_code;
  if (!code) {
    throw new Error(`Paystack created no subaccount: ${response.message}`);
  }

  logger.info(
    { businessId: params.businessId, subaccountCode: code },
    'Created Paystack subaccount for a shop',
  );

  return { subaccountCode: code, accountName: response.data?.account_name ?? '' };
}

/** Changes where an existing subaccount settles, or what Flowdesk keeps. */
export async function updateSubaccount(
  subaccountCode: string,
  params: {
    bankCode?: string;
    accountNumber?: string;
    commissionPercent?: number;
    businessName?: string;
  },
): Promise<void> {
  await paystackRequest(`/subaccount/${encodeURIComponent(subaccountCode)}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...(params.businessName ? { business_name: params.businessName } : {}),
      ...(params.bankCode ? { settlement_bank: params.bankCode } : {}),
      ...(params.accountNumber ? { account_number: params.accountNumber } : {}),
      ...(params.commissionPercent !== undefined
        ? { percentage_charge: params.commissionPercent }
        : {}),
    }),
  });
}

export interface HostedCharge {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/**
 * Opens a hosted checkout that settles to one shop's subaccount.
 *
 * `bearer` decides who absorbs Paystack's own fee. It is configuration rather
 * than a constant because it is a pricing decision — "the shop pays the
 * gateway fee, Flowdesk takes a percentage on top" is the default, and moving
 * that should not need a deploy.
 *
 * `channels` is restricted to what a Ghanaian customer will actually use. Left
 * unset, Paystack offers every method enabled on the account, including ones
 * that would strand a customer on a page they cannot complete.
 */
export async function initializeHostedCharge(params: {
  email: string;
  amountMinor: number;
  reference: string;
  subaccountCode: string;
  callbackUrl?: string | null;
  metadata: Record<string, unknown>;
}): Promise<HostedCharge> {
  const response = await paystackRequest<{
    authorization_url: string;
    access_code: string;
    reference: string;
  }>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: params.email,
      amount: params.amountMinor,
      currency: 'GHS',
      reference: params.reference,
      subaccount: params.subaccountCode,
      bearer: env.PAYSTACK_FEE_BEARER,
      channels: ['mobile_money', 'card'],
      ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
      metadata: JSON.stringify(params.metadata),
    }),
  });

  const data = response.data;
  if (!data?.authorization_url || !data.access_code) {
    throw new Error(`Paystack returned no checkout URL: ${response.message}`);
  }

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference ?? params.reference,
  };
}

export interface VerifiedCharge {
  status: string;
  amountMinor: number;
  currency: string;
  channel: string | null;
  paidAt: string | null;
  /** Paystack's fee, in the minor unit. */
  feesMinor: number | null;
  subaccountCode: string | null;
  /** The momo network or card brand, when Paystack reported one. */
  bank: string | null;
}

/**
 * Asks Paystack what actually happened to a reference.
 *
 * The webhook is fast but is a message; this is the record. Every settlement
 * is confirmed against it before a Payment row is written, so a forged or
 * replayed delivery cannot invent money — the signature proves the sender, and
 * this proves the charge.
 */
export async function verifyCharge(reference: string): Promise<VerifiedCharge | null> {
  try {
    const response = await paystackRequest<{
      status: string;
      amount: number;
      currency: string;
      channel?: string;
      paid_at?: string;
      fees?: number;
      subaccount?: { subaccount_code?: string };
      authorization?: { bank?: string; brand?: string };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });

    const data = response.data;
    if (!data) return null;

    return {
      status: data.status,
      amountMinor: data.amount,
      currency: data.currency,
      channel: data.channel ?? null,
      paidAt: data.paid_at ?? null,
      feesMinor: data.fees ?? null,
      subaccountCode: data.subaccount?.subaccount_code ?? null,
      bank: data.authorization?.bank ?? data.authorization?.brand ?? null,
    };
  } catch (error: unknown) {
    logger.error({ error, reference }, 'Could not verify a Paystack charge');
    return null;
  }
}
