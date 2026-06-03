import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { logger } from './logger.js';

const SLOW_QUERY_THRESHOLD_MS = 500;

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  client.$on('query', (event: Prisma.QueryEvent) => {
    if (event.duration >= SLOW_QUERY_THRESHOLD_MS) {
      logger.warn(
        {
          duration: event.duration,
          query: event.query,
          params: event.params,
          target: event.target,
        },
        'Slow Prisma query detected',
      );
    }
  });

  client.$on('error', (event: Prisma.LogEvent) => {
    logger.error({ target: event.target, message: event.message }, 'Prisma error');
  });

  client.$on('warn', (event: Prisma.LogEvent) => {
    logger.warn({ target: event.target, message: event.message }, 'Prisma warning');
  });

  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
