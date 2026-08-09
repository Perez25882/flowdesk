import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { logger } from '../../config/logger.js';
import { redis, sseSubscriber } from '../../config/redis.js';

export interface SSEEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Channel every API instance publishes dashboard events to. */
const SSE_CHANNEL = 'flowdesk:sse';

/**
 * Identifies this process, so an instance can tell its own published messages
 * apart from another instance's. It does not skip its own — see `broadcast`.
 */
const INSTANCE_ID = crypto.randomUUID();

interface WireMessage {
  instanceId: string;
  businessId: string;
  event: SSEEvent;
}

/**
 * Concurrent streams one business may hold on a single instance.
 *
 * A dashboard uses one. The ceiling exists because these connections are
 * long-lived and, once accepted, are not metered by the request rate limiter —
 * without a cap a single token could pin open sockets until the process ran out
 * of file descriptors. Generous enough for a shop with several tabs and phones
 * open at once.
 */
export const MAX_CONNECTIONS_PER_BUSINESS = 20;

export function sendHeartbeat(reply: FastifyReply): void {
  try {
    reply.raw.write(': heartbeat\n\n');
  } catch (error: unknown) {
    logger.debug({ error }, 'SSE heartbeat write failed');
  }
}

export class SSEManager {
  private static instance: SSEManager;

  private connections: Map<string, Map<string, FastifyReply>>;

  private constructor() {
    this.connections = new Map();
  }

  static getInstance(): SSEManager {
    if (!SSEManager.instance) {
      SSEManager.instance = new SSEManager();
    }
    return SSEManager.instance;
  }

  /**
   * Registers a stream. Returns null when the business is already at its
   * connection ceiling, which the caller surfaces as 429 rather than accepting
   * a socket it will not honour.
   */
  addConnection(businessId: string, reply: FastifyReply): string | null {
    if (this.getConnectionCount(businessId) >= MAX_CONNECTIONS_PER_BUSINESS) {
      logger.warn(
        { businessId, limit: MAX_CONNECTIONS_PER_BUSINESS },
        'SSE connection refused — per-business limit reached',
      );
      return null;
    }

    const connectionId = crypto.randomUUID();

    if (!this.connections.has(businessId)) {
      this.connections.set(businessId, new Map());
    }

    const businessConnections = this.connections.get(businessId);
    if (businessConnections) {
      businessConnections.set(connectionId, reply);
    }

    logger.info(
      { businessId, connectionId, totalConnections: this.getConnectionCount(businessId) },
      'SSE connection opened',
    );

    return connectionId;
  }

  removeConnection(businessId: string, connectionId: string): void {
    const businessConnections = this.connections.get(businessId);
    if (!businessConnections) return;

    businessConnections.delete(connectionId);

    if (businessConnections.size === 0) {
      this.connections.delete(businessId);
    }

    logger.info(
      { businessId, connectionId, totalConnections: this.getConnectionCount(businessId) },
      'SSE connection closed',
    );
  }

  /**
   * Publishes an event to every dashboard for a business, on every instance.
   *
   * The event goes to Redis rather than straight to local sockets, and this
   * instance delivers it when the message comes back on the subscription. That
   * single path means local and remote clients are treated identically — with
   * a direct local write plus a publish, whichever instance held the connection
   * would decide whether the user saw the update.
   *
   * If Redis is unavailable the event is written to local connections directly,
   * so a single-instance deployment keeps working during a Redis outage.
   */
  broadcast(businessId: string, event: SSEEvent): void {
    const message: WireMessage = { instanceId: INSTANCE_ID, businessId, event };

    redis.publish(SSE_CHANNEL, JSON.stringify(message)).catch((error: unknown) => {
      logger.warn(
        { error, businessId, eventType: event.type },
        'SSE publish failed — delivering to local connections only',
      );
      this.deliverLocal(businessId, event);
    });
  }

  /** Writes an event to the connections held by THIS instance. */
  deliverLocal(businessId: string, event: SSEEvent): void {
    const businessConnections = this.connections.get(businessId);
    if (!businessConnections || businessConnections.size === 0) return;

    const payload = JSON.stringify(event.payload);
    const data = `event: ${event.type}\ndata: ${payload}\n\n`;

    const deadConnections: Array<{ connectionId: string; error: unknown }> = [];

    businessConnections.forEach((reply, connectionId) => {
      try {
        reply.raw.write(data);
      } catch (error: unknown) {
        deadConnections.push({ connectionId, error });
      }
    });

    for (const dead of deadConnections) {
      logger.debug(
        { businessId, connectionId: dead.connectionId, error: dead.error },
        'Removing dead SSE connection',
      );
      this.removeConnection(businessId, dead.connectionId);
    }

    if (businessConnections.size > 0) {
      logger.debug(
        { businessId, eventType: event.type, recipientCount: businessConnections.size },
        'SSE event broadcast',
      );
    }
  }

  getConnectionCount(businessId: string): number {
    return this.connections.get(businessId)?.size ?? 0;
  }

  /** Total connections held by this instance, for the health endpoint. */
  getTotalConnectionCount(): number {
    let total = 0;
    this.connections.forEach((businessConnections) => {
      total += businessConnections.size;
    });
    return total;
  }
}

/**
 * Subscribes this instance to the shared SSE channel.
 *
 * Called once at startup. Without it, realtime updates only reach dashboards
 * connected to the instance that happened to process the event — so with more
 * than one API replica most users would silently stop receiving updates.
 */
export async function startSSEFanout(): Promise<void> {
  await sseSubscriber.subscribe(SSE_CHANNEL);

  sseSubscriber.on('message', (channel: string, raw: string) => {
    if (channel !== SSE_CHANNEL) return;

    let message: WireMessage;

    try {
      message = JSON.parse(raw) as WireMessage;
    } catch (error: unknown) {
      logger.warn({ error }, 'Discarded malformed SSE fan-out message');
      return;
    }

    if (!message.businessId || !message.event) return;

    SSEManager.getInstance().deliverLocal(message.businessId, message.event);
  });

  logger.info({ channel: SSE_CHANNEL, instanceId: INSTANCE_ID }, 'SSE fan-out subscribed');
}

export async function stopSSEFanout(): Promise<void> {
  await sseSubscriber.unsubscribe(SSE_CHANNEL).catch(() => undefined);
}
