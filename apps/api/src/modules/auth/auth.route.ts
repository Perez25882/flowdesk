import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { success, created } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireOwner } from '../../middleware/role.middleware.js';
import { attachBusinessContext } from '../../middleware/business-context.middleware.js';
import { sendPasswordResetEmail } from '../../services/email/transactional.js';
import { ValidationError } from '../../utils/errors.js';
import {
  describeFailure,
  issueEmailOtp,
  verifyEmailOtp,
} from './email-otp.service.js';
import {
  register,
  login,
  refreshTokens,
  logout,
  logoutAllSessions,
  requestPasswordReset,
  resetPassword,
  changePassword,
} from './auth.service.js';
import {
  RegisterSchema,
  LoginSchema,
  RefreshTokenSchema,
  LogoutSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ChangePasswordSchema,
  VerifyEmailSchema,
} from './auth.schema.js';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
} from './session-cookie.js';

/**
 * Issues a session: the refresh token goes into an httpOnly cookie and is
 * stripped from the JSON body, so the browser never holds it in JavaScript.
 */
function withSessionCookie<T extends { refreshToken: string }>(
  reply: FastifyReply,
  result: T,
): Omit<T, 'refreshToken'> {
  setRefreshCookie(reply, result.refreshToken);
  const { refreshToken: _omitted, ...safe } = result;
  return safe;
}

/**
 * Credential endpoints are rate limited far more tightly than the global
 * default. The global limit keys on the Authorization header, which is absent
 * here, so without this every unauthenticated caller would share one bucket.
 */
const CREDENTIAL_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '15 minutes',
    },
  },
};

/**
 * Codes are cheaper to guess than passwords, so they get their own, tighter
 * bucket. The service already limits attempts per code; this limits how many
 * codes one caller can burn through.
 */
const OTP_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 6,
      timeWindow: '15 minutes',
    },
  },
};

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Sends a fresh code to the signed-in owner's address.
   *
   * Behind `requireAuth` on purpose: an unauthenticated version keyed on an
   * email address would let anyone post someone else's address repeatedly and
   * use us to mail them. You have to already be in the account to ask.
   */
  app.post(
    '/auth/verify-email/request',
    { ...OTP_RATE_LIMIT, preHandler: [requireAuth, attachBusinessContext, requireOwner] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const issued = await issueEmailOtp(request.user.businessId, 'EMAIL_VERIFICATION');
      return success(reply, {
        expiresAt: issued.expiresAt.toISOString(),
        // Said plainly so a local run without Resend does not look broken.
        delivered: issued.delivered,
      });
    },
  );

  app.post(
    '/auth/verify-email/confirm',
    { ...OTP_RATE_LIMIT, preHandler: [requireAuth, attachBusinessContext, requireOwner] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = VerifyEmailSchema.parse(request.body);
      const result = await verifyEmailOtp(
        request.user.businessId,
        'EMAIL_VERIFICATION',
        body.code,
      );

      if (!result.ok) {
        throw new ValidationError(describeFailure(result.reason));
      }

      return success(reply, { message: 'Email verified.' });
    },
  );

  app.post(
    '/auth/register',
    CREDENTIAL_RATE_LIMIT,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RegisterSchema.parse(request.body);
      const result = await register(body);
      return created(reply, withSessionCookie(reply, result));
    },
  );

  app.post(
    '/auth/login',
    CREDENTIAL_RATE_LIMIT,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = LoginSchema.parse(request.body);
      const result = await login(body);
      return success(reply, withSessionCookie(reply, result));
    },
  );

  app.post(
    '/auth/forgot-password',
    CREDENTIAL_RATE_LIMIT,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ForgotPasswordSchema.parse(request.body);
      const token = await requestPasswordReset(body.email);

      if (token) {
        await sendPasswordResetEmail(body.email, token).catch((error: unknown) => {
          logger.error({ error }, 'Failed to send password reset email');
        });
      }

      // Always the same response, so the endpoint cannot confirm whether an
      // email is registered.
      //
      // The dev-only reset token is gated on NODE_ENV, never on `features.email`.
      // The old gate leaked a usable password-reset token in the HTTP response
      // whenever the email provider happened to be unconfigured — which is a
      // production misconfiguration, not a dev signal — turning "knows the
      // victim's email" into full account takeover. In production the token is
      // never returned regardless of email configuration.
      const includeDevToken = env.NODE_ENV !== 'production' && token;

      return success(reply, {
        message: 'If that email is registered, a reset link has been sent.',
        ...(includeDevToken ? { resetToken: token } : {}),
      });
    },
  );

  app.post(
    '/auth/reset-password',
    CREDENTIAL_RATE_LIMIT,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ResetPasswordSchema.parse(request.body);
      await resetPassword(body.token, body.password);
      return success(reply, { message: 'Password updated. Please sign in again.' });
    },
  );

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    // The body is optional now — browsers send the cookie instead.
    const body = RefreshTokenSchema.partial().parse(request.body ?? {});
    const token = readRefreshToken(request, body.refreshToken);

    if (!token) {
      clearRefreshCookie(reply);
      return reply
        .status(401)
        .send({ success: false, error: 'No active session', code: 'UNAUTHORIZED' });
    }

    try {
      const tokens = await refreshTokens(token);
      return success(reply, withSessionCookie(reply, tokens));
    } catch (error: unknown) {
      // A rejected refresh token is spent or revoked; drop the cookie so the
      // browser stops replaying it on every load.
      clearRefreshCookie(reply);
      throw error;
    }
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = LogoutSchema.partial().parse(request.body ?? {});
    const token = readRefreshToken(request, body.refreshToken);

    // Always clear the cookie, even if the token was already invalid — logout
    // must never leave a browser holding a credential.
    clearRefreshCookie(reply);

    if (token) {
      await logout(token).catch(() => undefined);
    }

    return success(reply, { message: 'Logged out successfully' });
  });

  app.post(
    '/auth/change-password',
    // Owner-only: this changes the Business account password. Staff tokens
    // should never reach the current-password compare step — defence in depth.
    { preHandler: [requireAuth, attachBusinessContext, requireOwner] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ChangePasswordSchema.parse(request.body);
      await changePassword(request.user.businessId, body.currentPassword, body.newPassword);
      return success(reply, { message: 'Password changed. Please sign in again.' });
    },
  );

  /**
   * Revokes every session for the business, including other people's.
   *
   * Owner-only: this signs out the entire team, so it belongs to the account
   * holder. Without the gate any staff account — including a delivery rider —
   * could log the owner out repeatedly.
   */
  app.post(
    '/auth/logout-all',
    { preHandler: [requireAuth, attachBusinessContext, requireOwner] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await logoutAllSessions(request.user.businessId);
      return success(reply, { message: 'All sessions logged out' });
    },
  );
}
