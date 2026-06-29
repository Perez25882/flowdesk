import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { success } from '../../utils/response.js';
import { EmbeddedSignupSchema, ManualConnectSchema } from './whatsapp.schema.js';
import {
  connectViaEmbeddedSignup,
  connectManually,
  getConnectionStatus,
  disconnect,
} from './whatsapp.service.js';

export default async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  // Public-safe config the browser needs to launch Embedded Signup.
  app.get('/whatsapp/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    return success(reply, {
      appId: env.META_APP_ID,
      configId: env.META_CONFIG_ID ?? null,
      apiVersion: env.META_API_VERSION,
      embeddedSignupEnabled: Boolean(env.META_CONFIG_ID),
    });
  });

  app.get('/whatsapp/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const status = await getConnectionStatus(request.business!.id);
    return success(reply, status);
  });

  app.post('/whatsapp/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = EmbeddedSignupSchema.parse(request.body);
    const status = await connectViaEmbeddedSignup(body, request.business!.id);
    return success(reply, status);
  });

  app.post('/whatsapp/connect/manual', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ManualConnectSchema.parse(request.body);
    const status = await connectManually(body, request.business!.id);
    return success(reply, status);
  });

  app.delete('/whatsapp/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
    await disconnect(request.business!.id);
    return success(reply, { connected: false });
  });
}
