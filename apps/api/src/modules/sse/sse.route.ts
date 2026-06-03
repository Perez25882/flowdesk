import jwt from 'jsonwebtoken';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { SSEManager, sendHeartbeat } from '../../services/sse/sse.manager.js';

interface JWTPayload {
  businessId: string;
  plan: string;
  staffId?: string;
  role?: string;
}

export default async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sse/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { token?: string }).token;

    if (!token) {
      return reply.status(401).send({ success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
    }

    let payload: JWTPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
    }

    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    for (const [key, value] of Object.entries(headers)) {
      reply.header(key, value);
    }

    reply.status(200);
    reply.raw.write('');

    const manager = SSEManager.getInstance();
    const connectionId = manager.addConnection(payload.businessId, reply);

    const connectedEvent = {
      type: 'connected',
      payload: {
        businessId: payload.businessId,
        plan: payload.plan,
        timestamp: new Date().toISOString(),
      },
    };

    try {
      reply.raw.write(`event: ${connectedEvent.type}\ndata: ${JSON.stringify(connectedEvent.payload)}\n\n`);
    } catch (error: unknown) {
      manager.removeConnection(payload.businessId, connectionId);
      return reply;
    }

    const heartbeatInterval = setInterval(() => {
      sendHeartbeat(reply);
    }, 30_000);

    request.raw.on('close', () => {
      clearInterval(heartbeatInterval);
      manager.removeConnection(payload.businessId, connectionId);
    });

    request.raw.on('error', () => {
      clearInterval(heartbeatInterval);
      manager.removeConnection(payload.businessId, connectionId);
    });

    return reply;
  });
}
