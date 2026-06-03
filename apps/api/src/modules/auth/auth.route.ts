import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { attachBusinessContext } from '../../middleware/business-context.middleware.js';
import {
  registerBusiness,
  requestOTP,
  verifyOTPAndLogin,
  refreshTokens,
  logout,
  logoutAllSessions,
} from './auth.service.js';
import {
  RegisterBusinessSchema,
  RequestOTPSchema,
  VerifyOTPSchema,
  RefreshTokenSchema,
  LogoutSchema,
} from './auth.schema.js';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = RegisterBusinessSchema.parse(request.body);
    const business = await registerBusiness(body);
    return created(reply, business);
  });

  app.post('/auth/otp/request', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = RequestOTPSchema.parse(request.body);
    await requestOTP(body.phone);
    return success(reply, { message: 'OTP sent successfully' });
  });

  app.post('/auth/otp/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = VerifyOTPSchema.parse(request.body);
    const tokens = await verifyOTPAndLogin(body.phone, body.otp);
    return success(reply, tokens);
  });

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = RefreshTokenSchema.parse(request.body);
    const tokens = await refreshTokens(body.refreshToken);
    return success(reply, tokens);
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = LogoutSchema.parse(request.body);
    await logout(body.refreshToken);
    return success(reply, { message: 'Logged out successfully' });
  });

  app.post(
    '/auth/logout-all',
    { preHandler: [requireAuth, attachBusinessContext] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await logoutAllSessions(request.user.businessId);
      return success(reply, { message: 'All sessions logged out' });
    },
  );
}
