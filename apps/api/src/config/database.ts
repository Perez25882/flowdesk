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
      // `event.params` is deliberately NOT logged. It is the bound parameter
      // list, verbatim: customer WhatsApp message bodies, customer phone
      // numbers, owner email addresses and bcrypt hashes. This line runs at
      // `warn`, which is emitted under the default production LOG_LEVEL=info,
      // so those values were being written to the production log for every
      // query that happened to be slow. The statement text and target are
      // enough to identify which query is slow; the values it ran with are not
      // needed to fix it.
      logger.warn(
        {
          duration: event.duration,
          query: event.query,
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
