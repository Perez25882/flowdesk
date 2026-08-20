import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Prisma } from '@prisma/client';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import type { RawBodyPluginOptions } from 'fastify-raw-body';
import { ZodError } from 'zod';
import { allowedOrigins, env, trustProxyValue } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './config/database.js';
import { redis, rateLimitRedis } from './config/redis.js';
import { isAppError } from './utils/errors.js';
import type { ApiError } from './utils/response.js';
import { requireAuth } from './middleware/auth.middleware.js';
import { attachBusinessContext } from './middleware/business-context.middleware.js';
import { rateLimitKeyGenerator, rateLimitMax } from './services/auth/rate-limit.js';

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
    // Configurable, and OFF by default. Blanket `trustProxy: true` made
    // `request.ip` derive from a client-supplied X-Forwarded-For header, so the
    // rate limiter — and the credential brute-force limiter keyed on it — could
    // be reset at will by rotating the header. Set TRUST_PROXY to the real hop
    // count in front of the deployed API.
    trustProxy: trustProxyValue(),
    pluginTimeout: 60_000,
  });

  // CORS: allow the configured frontend origin(s). Previously production used
  // `origin: false`, which rejects every cross-origin request — the deployed
  // web app could not call its own API.
  const origins = allowedOrigins();

  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? origins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(helmet, {
    // The API serves JSON, not documents; the frontend is a separate origin
    // with its own policy. Disabled here to avoid blocking Swagger UI in dev.
    contentSecurityPolicy: env.NODE_ENV === 'production',
    crossOriginEmbedderPolicy: false,
  });

  // Rate limiting: 100 req/min per IP for anonymous traffic, 1000 req/min per
  // authenticated business. Anonymous traffic is keyed on IP; authenticated
  // traffic on the business id extracted from the token, so one tenant cannot
  // exhaust another's budget and rotating a token does not reset the limit.
  //
  // The key and the ceiling both come from `services/auth/rate-limit.ts`, which
  // verifies the bearer token itself. Reading `request.user` here did nothing:
  // this plugin's hook runs at `onRequest` and `requireAuth` is a `preHandler`,
  // so `request.user` was always undefined and every tenant shared one IP-keyed
  // bucket of 100.
  //
  // Backed by Redis so the limit is shared across API instances — an in-memory
  // store silently multiplies the effective limit by the number of replicas.
  await app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: '1 minute',
    redis: rateLimitRedis,
    nameSpace: 'flowdesk:ratelimit:',
    keyGenerator: rateLimitKeyGenerator,
    // Fail open on a Redis outage rather than locking every user out.
    skipOnError: true,
  });

  // Parses the httpOnly refresh-token cookie. Unsigned: the value is already a
  // signed JWT that the server verifies, so a second signature adds nothing.
  await app.register(cookie);

  await app.register(sensible);
  await registerSwagger(app);

  // MUST be installed before the route plugins are registered. Fastify copies
  // the current error handler into each encapsulated child context as it boots,
  // so a handler set afterwards never reaches them — every route below would
  // fall back to Fastify's default error shape instead of the API envelope.
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return sendError(reply, error.statusCode, error.message, error.code);
    }

    if (error instanceof ZodError) {
      return sendError(reply, 400, formatZodError(error), 'VALIDATION_ERROR');
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(error);
      return sendError(reply, mapped.statusCode, mapped.message, mapped.code);
    }

    // Fastify's own errors (rate limit, payload size, malformed JSON) already
    // carry a sensible status; preserve it but return the standard envelope.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    // The body-parser's error text (e.g. "Expected property name ... at
    // position 36") is a raw V8 JSON message that leaked through here instead of
    // a route's own generic catch, because Fastify's content-type parser runs
    // before the handler. Match it however it is shaped — a Fastify FST_ERR_CTP
    // code, a raw SyntaxError, or a 400 whose message mentions JSON — and return
    // a generic message.
    const isBodyParseError =
      (typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP')) ||
      error instanceof SyntaxError ||
      (statusCode === 400 && /json/i.test(error.message));

    if (isBodyParseError) {
      return sendError(reply, statusCode < 500 ? statusCode : 400, 'Invalid request body', 'BAD_REQUEST');
    }

    if (statusCode < 500) {
      return sendError(reply, statusCode, error.message, error.code ?? 'BAD_REQUEST');
    }

    request.log.error({ err: error }, 'Unhandled application error');

    // Internal failures must not leak stack traces or driver messages.
    return sendError(reply, 500, 'Internal server error', 'INTERNAL_SERVER_ERROR');
  });

  app.get('/health', async () => getHealth());

  await app.register(async (apiApp: FastifyInstance) => {
    // Raw request bytes, for webhook signature verification.
    //
    // Registered HERE rather than inside the Meta webhook plugin. Fastify
    // encapsulation confines a plugin to the context it is registered in, so a
    // registration inside one route file never reaches its siblings — which is
    // why the Paystack handler had no `rawBody` and fell back to re-serialising
    // the parsed object. An HMAC over `JSON.stringify(body)` only matches by
    // luck: key order, escaped unicode and number formatting all differ from
    // the bytes that were actually signed.
    //
    // `global: false` keeps the buffer off every other route; the two webhook
    // routes opt in with `config: { rawBody: true }`.
    await apiApp.register(import('fastify-raw-body'), {
      field: 'rawBody',
      global: false,
      encoding: false,
      runFirst: true,
    } as RawBodyPluginOptions);

    // ── Public surface ────────────────────────────────────────────────────
    // Everything reachable without a token. Anything added here is internet
    // facing, so it must authenticate or authorise for itself.
    await apiApp.register((await import('./modules/webhook/webhook.route.js')).default);
    await apiApp.register((await import('./modules/auth/auth.route.js')).default);
    await apiApp.register((await import('./modules/sse/sse.route.js')).default);
    await apiApp.register((await import('./modules/billing/billing.route.js')).default);

    // Staff sign-in and invite acceptance: the routes through which a staff
    // member obtains a token, so they cannot require one.
    await apiApp.register((await import('./modules/staff/staff.route.js')).staffPublicRoutes);

    // WhatsApp routes authenticate per-route; /whatsapp/config is public so the
    // settings page can read the Embedded Signup configuration.
    await apiApp.register((await import('./modules/whatsapp/whatsapp.route.js')).default);

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
      await protectedApp.register((await import('./modules/dashboard/dashboard.route.js')).default);
      await protectedApp.register((await import('./modules/billing/billingCheckout.route.js')).default);
    });
  }, { prefix: '/api/v1' });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, 'Route not found', 'NOT_FOUND'),
  );

  return app;
}
