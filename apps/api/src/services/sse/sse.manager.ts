import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { logger } from '../../config/logger.js';

export interface SSEEvent {
  type: string;
  payload: Record<string, unknown>;
}

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

  addConnection(businessId: string, reply: FastifyReply): string {
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

  broadcast(businessId: string, event: SSEEvent): void {
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
}
