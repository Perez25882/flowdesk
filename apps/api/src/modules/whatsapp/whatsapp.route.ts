import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { success } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { attachBusinessContext } from '../../middleware/business-context.middleware.js';
import { requireOwner } from '../../middleware/role.middleware.js';
import { EmbeddedSignupSchema, ManualConnectSchema } from './whatsapp.schema.js';
import {
  connectViaEmbeddedSignup,
  connectManually,
  getConnectionStatus,
  disconnect,
} from './whatsapp.service.js';

const protectedRoute = { preHandler: [requireAuth, attachBusinessContext] };

// Connecting or disconnecting the WhatsApp number is owner-only. This is the
// spine of the whole product — every module depends on it — so a single
// unguarded request from a delivery rider could sever the business's messaging
// channel (a one-call DoS) or, with stolen Meta credentials, hijack it. These
// routes previously had no role check at all.
const ownerOnly = { preHandler: [requireAuth, attachBusinessContext, requireOwner] };

export default async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  // Public-safe config the browser needs to launch Embedded Signup.
  // Must stay unauthenticated so the login/register pages can read it.
  app.get('/whatsapp/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, {
      appId: env.META_APP_ID,
      configId: env.META_CONFIG_ID ?? null,
      apiVersion: env.META_API_VERSION,
      embeddedSignupEnabled: Boolean(env.META_CONFIG_ID),
      environment: env.NODE_ENV,
    });
  });

  app.get('/whatsapp/status', protectedRoute, async (request: FastifyRequest, reply: FastifyReply) => {
    const status = await getConnectionStatus(request.business!.id);
    return success(reply, status);
  });

  app.post('/whatsapp/connect', ownerOnly, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = EmbeddedSignupSchema.parse(request.body);
    const status = await connectViaEmbeddedSignup(body, request.business!.id);
    return success(reply, status);
  });

  app.post('/whatsapp/connect/manual', ownerOnly, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ManualConnectSchema.parse(request.body);
    const status = await connectManually(body, request.business!.id);
    return success(reply, status);
  });

  app.delete('/whatsapp/disconnect', ownerOnly, async (request: FastifyRequest, reply: FastifyReply) => {
    await disconnect(request.business!.id);
    return success(reply, { connected: false });
  });
}
