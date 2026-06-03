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
export const redisSubscriber = createRedisClient('flowdesk-subscriber');

export async function connectRedis(): Promise<void> {
  await Promise.all([redis.ping(), redisSubscriber.ping()]);
  logger.info('Redis clients connected');
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([redis.quit(), redisSubscriber.quit()]);
  logger.info('Redis clients disconnected');
}
