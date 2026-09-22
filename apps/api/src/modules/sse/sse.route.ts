import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { attachBusinessContext } from '../../middleware/business-context.middleware.js';
import {
  MAX_CONNECTIONS_PER_BUSINESS,
  SSEManager,
  sendHeartbeat,
  type SSESubscriber,
} from '../../services/sse/sse.manager.js';
import type { BusinessPlan, StaffRole } from '../../types/prisma-enums.js';

/**
 * Realtime stream authentication.
 *
 * `EventSource` cannot set an Authorization header, so the browser has to put
 * its credential in the URL. Rather than send the access token there — query
 * strings land in proxy and CDN access logs, browser history and Referer
 * headers, and that token is good for fifteen minutes of full API access — the
 * dashboard exchanges its bearer token for a ticket that is single-use, expires
 * in thirty seconds, and grants nothing but this one stream.
 */
const TICKET_PREFIX = 'flowdesk:sse:ticket:';
const TICKET_TTL_SECONDS = 30;

interface TicketRecord {
  businessId: string;
  plan: string;
  staffId?: string;
  role?: string;
}

/**
 * Redeems a ticket, deleting it in the same round trip.
 *
 * GETDEL is atomic, so two connections racing on one stolen ticket cannot both
 * succeed — the loser sees an unknown ticket and is rejected.
 */
async function redeemTicket(ticket: string): Promise<TicketRecord | null> {
  const raw = await redis.getdel(`${TICKET_PREFIX}${ticket}`);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TicketRecord;
  } catch {
    return null;
  }
}

export default async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/sse/ticket',
    // `attachBusinessContext` as well as `requireAuth`: without it a suspended,
    // inactive, soft-deleted or trial-expired business was refused on every
    // REST call but kept a fully working realtime feed, because this was the
    // one authenticated route that skipped the business-state gate.
    { preHandler: [requireAuth, attachBusinessContext] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const ticket = crypto.randomBytes(32).toString('base64url');

      const record: TicketRecord = {
        businessId: user.businessId,
        plan: user.plan as BusinessPlan,
      };
      if (user.staffId !== undefined) record.staffId = user.staffId;
      if (user.role !== undefined) record.role = user.role as StaffRole;

      await redis.set(
        `${TICKET_PREFIX}${ticket}`,
        JSON.stringify(record),
        'EX',
        TICKET_TTL_SECONDS,
      );

      return reply.send({
        success: true,
        data: { ticket, expiresIn: TICKET_TTL_SECONDS },
      });
    },
  );

  app.get('/sse/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    const ticket = (request.query as { ticket?: string }).ticket;

    if (!ticket) {
      return reply
        .status(401)
        .send({ success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
    }

    let record: TicketRecord | null;

    try {
      record = await redeemTicket(ticket);
    } catch (error: unknown) {
      // Redis is the only store for tickets; without it the stream cannot be
      // authenticated, so fail closed rather than admit an unverified client.
      logger.error({ error }, 'SSE ticket redemption failed');
      return reply
        .status(503)
        .send({ success: false, error: 'Realtime unavailable', code: 'SERVICE_UNAVAILABLE' });
    }

    if (!record) {
      return reply
        .status(401)
        .send({ success: false, error: 'Invalid or expired ticket', code: 'UNAUTHORIZED' });
    }

    const manager = SSEManager.getInstance();

    // Refused before the headers go out. Once this socket is an event stream
    // the only way to report a refusal is an error event the browser cannot
    // act on, so the limit has to be answered with a real status code here.
    if (manager.getConnectionCount(record.businessId) >= MAX_CONNECTIONS_PER_BUSINESS) {
      return reply.status(429).send({
        success: false,
        error: 'Too many open realtime connections',
        code: 'TOO_MANY_CONNECTIONS',
      });
    }

    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    // Headers must go out on the raw socket, not through `reply.header()`.
    // Fastify only applies its own header map when `reply.send()` runs, and
    // this handler never calls it — so the first `reply.raw.write()` would
    // trigger an implicit writeHead carrying none of them. The browser then
    // sees a stream with no Content-Type, refuses it as `text/plain`, and
    // EventSource retries forever, which presents as a dashboard stuck on
    // "Reconnecting".
    //
    // `hijack()` tells Fastify this response is now managed by hand, so it
    // does not also try to serialise a reply onto the same socket.
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.flushHeaders();

    // The ticket already recorded who this is; the connection has to carry it
    // too, or the fan-out has no way to decide what this subscriber may see and
    // falls back to writing everything to everyone.
    const subscriber: SSESubscriber = {};
    if (record.staffId !== undefined) subscriber.staffId = record.staffId;
    if (record.role !== undefined) subscriber.role = record.role as StaffRole;

    const connectionId = manager.addConnection(record.businessId, reply, subscriber);

    // Lost a race against another connection for the last slot.
    if (connectionId === null) {
      reply.raw.end();
      return reply;
    }

    const connectedPayload = {
      businessId: record.businessId,
      plan: record.plan,
      timestamp: new Date().toISOString(),
    };

    try {
      reply.raw.write(`event: connected\ndata: ${JSON.stringify(connectedPayload)}\n\n`);
    } catch {
      // The client disconnected between accepting the request and the first
      // write; drop the registration so it is not counted as live.
      manager.removeConnection(record.businessId, connectionId);
      return reply;
    }

    const heartbeatInterval = setInterval(() => {
      sendHeartbeat(reply);
    }, 30_000);

    const teardown = (): void => {
      clearInterval(heartbeatInterval);
      manager.removeConnection(record.businessId, connectionId);
    };

    request.raw.on('close', teardown);
    request.raw.on('error', teardown);

    return reply;
  });
}
