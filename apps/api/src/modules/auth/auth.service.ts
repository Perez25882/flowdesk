import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { UnauthorizedError, ConflictError, ExternalServiceError } from '../../utils/errors.js';
import { encryptSecret } from '../../utils/crypto.js';
import {
  exchangeCodeForToken,
  fetchMetaUserInfo,
  fetchPhoneNumberInfo,
  subscribeWabaToApp,
} from '../../services/whatsapp/meta.js';
import type { BusinessPlan, StaffRole } from '../../types/prisma-enums.js';
import {
  createBusiness,
  findBusinessByMetaUserId,
  findSession,
  createSession,
  deleteSession,
  deleteAllSessions,
  type CreateBusinessInput,
} from './auth.repository.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const TRIAL_DAYS = 14;
const PAYSTACK_API_URL = 'https://api.paystack.co/customer';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface MetaSignupInput {
  code: string;
  phoneNumberId: string;
  wabaId?: string | undefined;
}

export interface MetaLoginInput {
  code: string;
}

interface AccessTokenPayload {
  businessId: string;
  plan: BusinessPlan;
  staffId?: string;
  role?: StaffRole;
}

interface RefreshTokenPayload {
  businessId: string;
  jti: string;
}

function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function normalizeGhanaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    return `233${digits.slice(1)}`;
  }

  if (digits.startsWith('233')) {
    return digits;
  }

  return `233${digits}`;
}

async function createSessionTokens(businessId: string, plan: BusinessPlan): Promise<AuthTokens> {
  const accessPayload: AccessTokenPayload = { businessId, plan };
  const jti = crypto.randomUUID();
  const refreshPayload: RefreshTokenPayload = { businessId, jti };

  const accessToken = signAccessToken(accessPayload);
  const refreshToken = signRefreshToken(refreshPayload);
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await createSession({
    businessId,
    refreshTokenHash,
    expiresAt,
  });

  return { accessToken, refreshToken };
}

export async function createPaystackCustomer(
  email: string,
  name: string,
  phone?: string,
): Promise<string> {
  const response = await fetch(PAYSTACK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      first_name: name,
      ...(phone ? { phone } : {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, body: errorBody }, 'Paystack customer creation failed');
    throw new ExternalServiceError('Failed to create Paystack customer');
  }

  const data = (await response.json()) as { data: { customer_code: string } };
  return data.data.customer_code;
}

export async function signupWithMeta(input: MetaSignupInput): Promise<AuthTokens> {
  const accessToken = await exchangeCodeForToken(input.code);
  const metaUser = await fetchMetaUserInfo(accessToken);

  const existing = await findBusinessByMetaUserId(metaUser.id);
  if (existing) {
    throw new ConflictError('An account already exists for this Facebook user. Please sign in instead.');
  }

  if (input.wabaId) {
    await subscribeWabaToApp(input.wabaId, accessToken);
  }

  const phoneInfo = await fetchPhoneNumberInfo(input.phoneNumberId, accessToken);

  const phone = phoneInfo.displayPhoneNumber
    ? normalizeGhanaPhone(phoneInfo.displayPhoneNumber)
    : undefined;

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

  const billingEmail = metaUser.email ?? `${metaUser.id}@flowdesk.local`;
  let paystackCustomerId: string | undefined;
  try {
    paystackCustomerId = await createPaystackCustomer(billingEmail, metaUser.name, phone);
  } catch (error: unknown) {
    logger.warn({ error, metaUserId: metaUser.id }, 'Paystack customer creation failed — proceeding without Paystack ID');
  }

  const createData: CreateBusinessInput = {
    name: metaUser.name || 'My Business',
    ownerName: metaUser.name || 'Owner',
    metaUserId: metaUser.id,
    email: metaUser.email,
    phone,
    trialEndsAt,
  };
  if (paystackCustomerId !== undefined) createData.paystackCustomerId = paystackCustomerId;

  const business = await createBusiness(createData);

  await prisma.business.update({
    where: { id: business.id },
    data: {
      waPhoneNumberId: input.phoneNumberId,
      waAccessToken: encryptSecret(accessToken),
      waWebhookVerified: true,
    },
  });

  logger.info(
    { businessId: business.id, metaUserId: metaUser.id, phoneNumberId: input.phoneNumberId },
    'Business created and WhatsApp connected via Meta signup',
  );

  return createSessionTokens(business.id, business.plan);
}

export async function loginWithMeta(input: MetaLoginInput): Promise<AuthTokens> {
  const accessToken = await exchangeCodeForToken(input.code);
  const metaUser = await fetchMetaUserInfo(accessToken);

  const business = await findBusinessByMetaUserId(metaUser.id);
  if (!business) {
    throw new UnauthorizedError('No account found for this Facebook user. Please sign up first.');
  }

  if (!business.active) {
    throw new UnauthorizedError('Business account is inactive');
  }

  if (business.suspendedAt) {
    throw new UnauthorizedError(
      business.suspendReason
        ? `Business suspended: ${business.suspendReason}`
        : 'Business account is suspended',
    );
  }

  return createSessionTokens(business.id, business.plan);
}

export async function refreshTokens(rawRefreshToken: string): Promise<AuthTokens> {
  try {
    verifyRefreshToken(rawRefreshToken);
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const refreshTokenHash = hashToken(rawRefreshToken);
  const session = await findSession(refreshTokenHash);

  if (!session) {
    throw new UnauthorizedError('Session not found or revoked');
  }

  if (session.expiresAt < new Date()) {
    await deleteSession(refreshTokenHash);
    throw new UnauthorizedError('Refresh token expired');
  }

  await deleteSession(refreshTokenHash);

  const accessPayload: AccessTokenPayload = {
    businessId: session.business.id,
    plan: session.business.plan,
  };

  if (session.staff) {
    accessPayload.staffId = session.staff.id;
    accessPayload.role = session.staff.role;
  }

  const jti = crypto.randomUUID();
  const newRefreshPayload: RefreshTokenPayload = {
    businessId: session.business.id,
    jti,
  };

  const accessToken = signAccessToken(accessPayload);
  const newRefreshToken = signRefreshToken(newRefreshPayload);
  const newRefreshTokenHash = hashToken(newRefreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const sessionInput: Parameters<typeof createSession>[0] = {
    businessId: session.business.id,
    refreshTokenHash: newRefreshTokenHash,
    expiresAt,
  };
  if (session.staffId !== null) sessionInput.staffId = session.staffId;
  await createSession(sessionInput);

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  const refreshTokenHash = hashToken(rawRefreshToken);
  await deleteSession(refreshTokenHash);
}

export async function logoutAllSessions(businessId: string): Promise<void> {
  await deleteAllSessions(businessId);
}
