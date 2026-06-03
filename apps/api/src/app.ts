import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Prisma } from '@prisma/client';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './config/database.js';
import { redis } from './config/redis.js';
import { isAppError } from './utils/errors.js';
import type { ApiError } from './utils/response.js';
import { requireAuth } from './middleware/auth.middleware.js';
import { attachBusinessContext } from './middleware/business-context.middleware.js';

interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  db: 'connected' | 'disconnected';
  redis: 'connected' | 'disconnected';
  timestamp: string;
  uptime: number;
}

function sendError(reply: FastifyReply, statusCode: number, error: string, code: string): FastifyReply {
  const payload: ApiError = {
    success: false,
    error,
    code,
  };

  return reply.status(statusCode).send(payload);
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.') || 'request';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (error.code === 'P2002') {
    return {
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A record with this value already exists',
    };
  }

  if (error.code === 'P2025') {
    return {
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Requested record was not found',
    };
  }

  return {
    statusCode: 500,
    code: 'DATABASE_ERROR',
    message: 'A database error occurred',
  };
}

async function getHealth(): Promise<HealthResponse> {
  const timestamp = new Date().toISOString();
  const uptime = process.uptime();

  const db = await prisma
    .$queryRaw`SELECT 1`
    .then(() => 'connected' as const)
    .catch(() => 'disconnected' as const);

  const redisStatus = await redis
    .ping()
    .then(() => 'connected' as const)
    .catch(() => 'disconnected' as const);

  const status = db === 'connected' && redisStatus === 'connected' ? 'ok' : 'down';

  return {
    status,
    db,
    redis: redisStatus,
    timestamp,
    uptime,
  };
}

async function registerSwagger(app: FastifyInstance): Promise<void> {
  if (env.NODE_ENV !== 'development') {
    return;
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Flowdesk API',
        description: 'Flowdesk WhatsApp operations API',
        version: '0.1.0',
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  await app.register(helmet);

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(sensible);
  await registerSwagger(app);

  app.get('/health', async () => getHealth());

  await app.register(async (apiApp: FastifyInstance) => {
    await apiApp.register((await import('./modules/webhook/webhook.route.js')).default);
    await apiApp.register((await import('./modules/auth/auth.route.js')).default);
    await apiApp.register((await import('./modules/sse/sse.route.js')).default);

    await apiApp.register((await import('./modules/billing/billing.route.js')).default);

    await apiApp.register(async (protectedApp: FastifyInstance) => {
      protectedApp.addHook('preHandler', requireAuth);
      protectedApp.addHook('preHandler', attachBusinessContext);
      await protectedApp.register((await import('./modules/orders/orders.route.js')).default);
      await protectedApp.register((await import('./modules/payments/payments.route.js')).default);
      await protectedApp.register((await import('./modules/products/products.route.js')).default);
      await protectedApp.register((await import('./modules/customers/customers.route.js')).default);
      await protectedApp.register((await import('./modules/messages/messages.route.js')).default);
      await protectedApp.register((await import('./modules/settings/settings.route.js')).default);
      await protectedApp.register((await import('./modules/staff/staff.route.js')).default);
    });
  }, { prefix: '/api/v1' });

  app.setErrorHandler((error, _request, reply) => {
    const r = reply;
    if (isAppError(error)) {
      return sendError(r, error.statusCode, error.message, error.code);
    }

    if (error instanceof ZodError) {
      return sendError(r, 400, formatZodError(error), 'VALIDATION_ERROR');
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mappedError = mapPrismaError(error);
      return sendError(r, mappedError.statusCode, mappedError.message, mappedError.code);
    }

    app.log.error({ error }, 'Unhandled application error');

    return sendError(r, 500, 'Internal server error', 'INTERNAL_SERVER_ERROR');
  });

  return app;
}
