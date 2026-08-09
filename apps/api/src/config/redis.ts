import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

const MAX_RETRY_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 5_000;

function retryStrategy(times: number): number | null {
  if (times > MAX_RETRY_ATTEMPTS) {
    logger.error({ attempts: times }, 'Redis retry attempts exhausted');
    return null;
  }

  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (times - 1), MAX_RETRY_DELAY_MS);
}

function createRedisClient(connectionName: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    connectionName,
    maxRetriesPerRequest: null,
    retryStrategy,
    enableReadyCheck: true,
  });

  client.on('connect', () => {
    logger.info({ connectionName }, 'Redis client connected');
  });

  client.on('ready', () => {
    logger.info({ connectionName }, 'Redis client ready');
  });

  client.on('error', (error: Error) => {
    logger.error({ connectionName, error }, 'Redis client error');
  });

  client.on('close', () => {
    logger.warn({ connectionName }, 'Redis client connection closed');
  });

  client.on('reconnecting', (delay: number) => {
    logger.warn({ connectionName, delay }, 'Redis client reconnecting');
  });

  return client;
}

export const redis = createRedisClient('flowdesk-main');

/**
 * BullMQ blocks on this connection while waiting for jobs, so it cannot be
 * shared with request-path commands — a blocked client would stall them.
 */
export const redisSubscriber = createRedisClient('flowdesk-subscriber');

/**
 * Dedicated client for the rate limiter.
 *
 * `maxRetriesPerRequest` is set so a Redis stall fails the limiter quickly and
 * `skipOnError` can let the request through, rather than queueing commands
 * until every inbound request times out.
 */
export const rateLimitRedis = new Redis(env.REDIS_URL, {
  connectionName: 'flowdesk-ratelimit',
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy,
});

rateLimitRedis.on('error', (error: Error) => {
  logger.error({ connectionName: 'flowdesk-ratelimit', error }, 'Redis client error');
});

/**
 * Dedicated connection for SSE fan-out.
 *
 * A Redis connection in subscriber mode may only issue subscribe commands, so
 * this cannot share `redis` (request-path commands) or `redisSubscriber`
 * (BullMQ blocks on it while waiting for jobs).
 */
export const sseSubscriber = createRedisClient('flowdesk-sse-sub');

export async function connectRedis(): Promise<void> {
  await Promise.all([redis.ping(), redisSubscriber.ping()]);
  logger.info('Redis clients connected');
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([
    redis.quit(),
    redisSubscriber.quit(),
    sseSubscriber.quit().catch(() => undefined),
    rateLimitRedis.quit().catch(() => undefined),
  ]);
  logger.info('Redis clients disconnected');
}
