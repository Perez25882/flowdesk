import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { UnauthorizedError, ConflictError, ExternalServiceError } from '../../utils/errors.js';
import { sendWhatsAppMessage, sendWhatsAppMessageGlobal } from '../../services/whatsapp/outbound.js';
import type { BusinessPlan, StaffRole } from '../../types/prisma-enums.js';
import {
  createBusiness,
  findBusinessByPhone,
  findSession,
  createSession,
  deleteSession,
  deleteAllSessions,
  type CreateBusinessInput,
} from './auth.repository.js';

const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 3;
const OTP_ATTEMPTS_TTL_SECONDS = 900;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const TRIAL_DAYS = 14;
const PAYSTACK_API_URL = 'https://api.paystack.co/customer';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterBusinessInput {
  ownerName: string;
  phone: string;
  businessName: string;
}

function normalizeGhanaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    return `233${digits.slice(1)}`;
  }

  if (digits.startsWith('233')) {
    return digits;
  }

  return `233${digits}`;
}

function generateOTP(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getOTPKey(phone: string): string {
  return `otp:${phone}`;
}

function getAttemptsKey(phone: string): string {
  return `otp_attempts:${phone}`;
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

async function sendOTPWhatsApp(phone: string, message: string): Promise<void> {
  const business = await findBusinessByPhone(phone);
  try {
    if (business) {
      // Login OTP — use business's own credentials if connected, otherwise global fallback
      await sendWhatsAppMessage(phone, message, business.id);
      logger.info({ phone, businessId: business.id }, 'OTP sent via WhatsApp');
    } else {
      // Registration OTP — business doesn't exist yet, use global credentials
      await sendWhatsAppMessageGlobal(phone, message);
      logger.info({ phone }, 'OTP sent via WhatsApp (global credentials)');
    }
  } catch (error: unknown) {
    logger.error({ error, phone, businessId: business?.id }, 'Failed to send OTP via WhatsApp');
  }
}

export async function requestOTP(rawPhone: string): Promise<void> {
  const phone = normalizeGhanaPhone(rawPhone);

  const attemptsKey = getAttemptsKey(phone);
  const attempts = Number(await redis.get(attemptsKey)) || 0;

  if (attempts >= OTP_MAX_ATTEMPTS) {
    throw new UnauthorizedError('Too many attempts. Please wait 15 minutes and try again.');
  }

  const otp = generateOTP();
  const otpKey = getOTPKey(phone);

  await redis.setex(otpKey, OTP_TTL_SECONDS, otp);
  await redis.setex(attemptsKey, OTP_ATTEMPTS_TTL_SECONDS, String(attempts));

  const message = `Your Flowdesk verification code is: ${otp}. It expires in 5 minutes.`;
  await sendOTPWhatsApp(phone, message);

  logger.info({ phone }, 'OTP generated and sent via WhatsApp');
}

export async function verifyOTPAndLogin(rawPhone: string, rawOtp: string): Promise<AuthTokens> {
  const phone = normalizeGhanaPhone(rawPhone);

  const otpKey = getOTPKey(phone);
  const storedOTP = await redis.get(otpKey);

  if (!storedOTP) {
    throw new UnauthorizedError('OTP expired or not found');
  }

  const attemptsKey = getAttemptsKey(phone);
  const attempts = Number(await redis.get(attemptsKey)) || 0;

  if (attempts >= OTP_MAX_ATTEMPTS) {
    throw new UnauthorizedError('Too many failed attempts. Please request a new OTP.');
  }

  if (storedOTP !== rawOtp) {
    await redis.incr(attemptsKey);
    await redis.expire(attemptsKey, OTP_ATTEMPTS_TTL_SECONDS);
    throw new UnauthorizedError('Invalid OTP');
  }

  await redis.del(otpKey);
  await redis.del(attemptsKey);

  const business = await findBusinessByPhone(phone);

  if (!business) {
    throw new UnauthorizedError('No account found for this phone number');
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

  const accessPayload: AccessTokenPayload = {
    businessId: business.id,
    plan: business.plan,
  };

  const jti = crypto.randomUUID();
  const refreshPayload: RefreshTokenPayload = {
    businessId: business.id,
    jti,
  };

  const accessToken = signAccessToken(accessPayload);
  const refreshToken = signRefreshToken(refreshPayload);
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await createSession({
    businessId: business.id,
    refreshTokenHash,
    expiresAt,
  });

  return { accessToken, refreshToken };
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

export async function createPaystackCustomer(phone: string, name: string): Promise<string> {
  const response = await fetch(PAYSTACK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${phone}@flowdesk.local`,
      first_name: name,
      phone,
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

export async function registerBusiness(data: RegisterBusinessInput): Promise<{
  id: string;
  name: string;
  ownerName: string;
  phone: string;
  trialEndsAt: Date;
}> {
  const phone = normalizeGhanaPhone(data.phone);

  const existing = await findBusinessByPhone(phone);
  if (existing) {
    throw new ConflictError('A business is already registered with this phone number');
  }

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

  let paystackCustomerId: string | undefined;

  try {
    paystackCustomerId = await createPaystackCustomer(phone, data.ownerName);
  } catch (error: unknown) {
    logger.warn({ error, phone }, 'Paystack customer creation failed — proceeding without Paystack ID');
  }

  const createData: CreateBusinessInput = {
    name: data.businessName,
    ownerName: data.ownerName,
    phone,
    trialEndsAt,
  };
  if (paystackCustomerId !== undefined) createData.paystackCustomerId = paystackCustomerId;

  const business = await createBusiness(createData);

  return {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    phone: business.phone,
    trialEndsAt: business.trialEndsAt ?? trialEndsAt,
  };
}

export { normalizeGhanaPhone };
