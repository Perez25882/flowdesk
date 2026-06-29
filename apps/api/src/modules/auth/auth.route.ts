import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { attachBusinessContext } from '../../middleware/business-context.middleware.js';
import { signupWithMeta, loginWithMeta, refreshTokens, logout, logoutAllSessions } from './auth.service.js';
import { MetaSignupSchema, MetaLoginSchema, RefreshTokenSchema, LogoutSchema } from './auth.schema.js';

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/meta/signup', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = MetaSignupSchema.parse(request.body);
    const tokens = await signupWithMeta(body);
    return success(reply, tokens);
  });

  app.post('/auth/meta/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = MetaLoginSchema.parse(request.body);
    const tokens = await loginWithMeta(body);
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
