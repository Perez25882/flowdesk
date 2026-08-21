import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Two tiers of validation:
 *
 *   Core       — always required. Without these the process cannot function
 *                at all (database, cache, token signing, secret encryption).
 *   Integration— optional in development so the product boots and the whole
 *                message pipeline can be exercised locally without a Meta app,
 *                an S3 bucket or a Paystack account. Each group is REQUIRED in
 *                production, enforced by `assertProductionIntegrations` below.
 *
 * Services must branch on the exported `features` flags rather than assuming a
 * value is present. Failing to boot because an optional vendor key is missing
 * is a worse outcome than degrading that one capability.
 */

const REQUIRED_SECRET_MIN_LENGTH = 32;
const DEFAULT_HAIKU_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Loads the monorepo-root `.env` so the API, Prisma CLI and workers all read a
 * single file regardless of which directory the process was started from.
 * Falls back to default dotenv resolution (cwd) when no root file is found.
 */
function loadDotenv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));

  for (let dir = here, i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env');

    if (fs.existsSync(candidate) && fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      config({ path: candidate });
      return;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  config();
}

loadDotenv();

const booleanFromString = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.toLowerCase() === 'true';
}, z.boolean());

/** Treats empty/whitespace-only vars as absent, so a blank line in .env behaves like "unset". */
const optionalString = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}, z.string().optional());

const envSchema = z.object({
  // ── Core: always required ───────────────────────────────────────────────
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid connection URL'),
  JWT_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  JWT_REFRESH_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  // 32-byte key encoded as 64 hex chars — AES-256-GCM encryption of secrets at
  // rest (per-business WhatsApp access tokens).
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // How much to trust `X-Forwarded-For` when deriving the client IP.
  //
  // `false` (default) = ignore the header, use the socket address. This is the
  // safe default: with blanket trust, `request.ip` is fully attacker-controlled,
  // which let a client rotate the header to reset every rate-limit and
  // brute-force bucket. In production, set to the NUMBER of trusted proxy hops
  // in front of the API (e.g. "1" behind a single load balancer) so only that
  // proxy's appended address is trusted. A comma-separated IP/CIDR list is also
  // accepted and passed through to Fastify.
  TRUST_PROXY: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Origin allowed to call the API. Comma-separated for multiple origins.
  // Required in production — CORS is deny-all without it.
  FRONTEND_URL: optionalString,

  // ── Meta WhatsApp Cloud API ─────────────────────────────────────────────
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_VERIFY_TOKEN: optionalString,
  META_WEBHOOK_SECRET: optionalString,
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'META_API_VERSION must look like v20.0')
    .default('v20.0'),
  META_PHONE_NUMBER_ID: optionalString,
  META_ACCESS_TOKEN: optionalString,
  // Meta Embedded Signup configuration id. Only needed for self-serve
  // WhatsApp onboarding; account signup itself uses email + password.
  META_CONFIG_ID: optionalString,

  // ── AI / Intent classification ──────────────────────────────────────────
  // Absent = rule engine only. The rule engine handles ~80% of traffic, so the
  // pipeline stays functional; ambiguous messages fall through to review.
  AI_PROVIDER: z.enum(['anthropic', 'nvidia']).default('anthropic'),
  ANTHROPIC_API_KEY: optionalString,
  NVIDIA_API_KEY: optionalString,
  NVIDIA_MODEL: z.string().min(1).default('meta/llama-3.1-8b-instruct'),
  HAIKU_FALLBACK_ENABLED: booleanFromString.default(true),
  HAIKU_CONFIDENCE_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_HAIKU_CONFIDENCE_THRESHOLD),

  // ── The assistant ───────────────────────────────────────────────────────
  // Distinct from the label-only classifier above. This one is given the shop's
  // catalogue and facts and asked to decide how to respond — a much harder task
  // than picking a label, so it wants a bigger model than the classifier uses.
  //
  // Unset means "the provider's default", resolved below rather than here so the
  // right default follows AI_PROVIDER instead of being pinned to one vendor.
  ASSISTANT_MODEL: optionalString,
  // Anthropic only. Ignored by other providers.
  ASSISTANT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(20_000),
  // Caps reasoning AND the reply together, so it needs room for both.
  ASSISTANT_MAX_TOKENS: z.coerce.number().int().min(512).max(16_000).default(2_048),

  // ── AWS S3 (media) ──────────────────────────────────────────────────────
  // Absent = inbound media is recorded but not archived. Meta media URLs
  // expire in ~5 minutes, so production requires this.
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  AWS_REGION: z.string().min(1).default('eu-west-1'),
  AWS_S3_BUCKET: optionalString,

  // ── Email ───────────────────────────────────────────────────────────────
  RESEND_API_KEY: optionalString,
  RESEND_FROM_EMAIL: z
    .string()
    .email('RESEND_FROM_EMAIL must be a valid email address')
    .optional()
    .or(z.literal('').transform(() => undefined)),

  // ── Billing ─────────────────────────────────────────────────────────────
  PAYSTACK_SECRET_KEY: optionalString,
  /**
   * Paystack plan codes, one per tier.
   *
   * Without a plan code `initializeTransaction` creates a ONE-OFF CHARGE:
   * Paystack makes no subscription, `charge.success` carries no
   * subscription_code, `paystackSubCode` stays null — and a customer who has
   * paid still reads as a lapsed trial 48 hours later. Cancel, pause and
   * downgrade also have nothing to act on. Optional so development works
   * without them; a production deployment that wants recurring billing must
   * set all three.
   */
  PAYSTACK_PLAN_STARTER: optionalString,
  PAYSTACK_PLAN_BUSINESS: optionalString,
  PAYSTACK_PLAN_GROWTH: optionalString,
  PAYSTACK_PUBLIC_KEY: optionalString,

  // ── Monitoring ──────────────────────────────────────────────────────────
  SENTRY_DSN: optionalString.refine(
    (value) => value === undefined || /^https?:\/\//.test(value),
    'SENTRY_DSN must be a URL',
  ),
})
  /**
   * The two signing secrets must differ.
   *
   * `role.middleware.ts` reads the ABSENCE of a staff id as "this is the
   * owner", and a refresh token's payload carries no staff id. Token typing
   * (`services/auth/tokens.ts`) now stops a refresh token being replayed as a
   * bearer token on its own, but the two secrets being equal removes an entire
   * layer of that defence for the sake of one careless copy-paste in a
   * deployment config. Cheaper to refuse at boot.
   */
  .refine((values) => values.JWT_SECRET !== values.JWT_REFRESH_SECRET, {
    message: 'JWT_SECRET and JWT_REFRESH_SECRET must be different values',
    path: ['JWT_REFRESH_SECRET'],
  });

export type Env = z.infer<typeof envSchema>;

export interface Features {
  /** Outbound WhatsApp sending and inbound webhook verification are possible. */
  whatsapp: boolean;
  /** Embedded Signup can be offered to owners for connecting their number. */
  whatsappSignup: boolean;
  /** LLM fallback for ambiguous intent classification is available. */
  aiClassification: boolean;
  /** Inbound media can be archived to durable storage. */
  mediaStorage: boolean;
  /** Transactional email can be sent. */
  email: boolean;
  /** Subscription billing is available. */
  billing: boolean;
  /** Errors are reported to Sentry. */
  errorReporting: boolean;
}

function formatEnvError(error: z.ZodError): string {
  const formattedIssues = error.issues
    .map((issue) => {
      const path = issue.path.join('.') || 'environment';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  return `Invalid environment configuration: ${formattedIssues}`;
}

function computeFeatures(parsed: Env): Features {
  return {
    // Flowdesk is a Meta Tech Provider: every business connects its OWN
    // WhatsApp number through Embedded Signup, and the per-tenant phone number
    // id and access token live encrypted on the Business row. The platform
    // itself therefore needs only its app-level credentials.
    //
    // `whatsapp` used to require META_ACCESS_TOKEN and META_PHONE_NUMBER_ID,
    // which are one specific number's credentials. Requiring them of the
    // platform meant a production deployment could not boot without pasting one
    // tenant's secrets into the shared environment — the exact coupling the
    // Tech Provider model exists to remove.
    whatsapp: Boolean(
      parsed.META_APP_ID &&
        parsed.META_APP_SECRET &&
        parsed.META_CONFIG_ID &&
        parsed.META_WEBHOOK_SECRET &&
        parsed.META_VERIFY_TOKEN,
    ),
    whatsappSignup: Boolean(parsed.META_APP_ID && parsed.META_APP_SECRET && parsed.META_CONFIG_ID),
    aiClassification:
      parsed.HAIKU_FALLBACK_ENABLED &&
      Boolean(parsed.AI_PROVIDER === 'nvidia' ? parsed.NVIDIA_API_KEY : parsed.ANTHROPIC_API_KEY),
    mediaStorage: Boolean(
      parsed.AWS_ACCESS_KEY_ID && parsed.AWS_SECRET_ACCESS_KEY && parsed.AWS_S3_BUCKET,
    ),
    email: Boolean(parsed.RESEND_API_KEY && parsed.RESEND_FROM_EMAIL),
    billing: Boolean(parsed.PAYSTACK_SECRET_KEY && parsed.PAYSTACK_PUBLIC_KEY),
    errorReporting: Boolean(parsed.SENTRY_DSN),
  };
}

/**
 * Integrations that are optional locally but mandatory in production. Fails
 * fast at boot rather than surfacing as a runtime error on a customer request.
 */
function assertProductionIntegrations(parsed: Env, flags: Features): void {
  if (parsed.NODE_ENV !== 'production') {
    return;
  }

  const missing: string[] = [];

  if (!flags.whatsapp) {
    missing.push(
      'WhatsApp platform credentials (META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_WEBHOOK_SECRET, META_VERIFY_TOKEN)',
    );
  }

  // Refused rather than merely unused. These are a single WhatsApp number's
  // credentials; in a Tech Provider deployment every number belongs to a
  // tenant, so their presence in the shared environment means either a
  // half-finished migration or a developer's number about to be used in
  // production. Both are worth failing the boot for — the failure mode
  // otherwise is one business's messages going out over another's number.
  if (parsed.META_ACCESS_TOKEN || parsed.META_PHONE_NUMBER_ID) {
    missing.push(
      'META_ACCESS_TOKEN and META_PHONE_NUMBER_ID must NOT be set in production — each business supplies its own through Embedded Signup',
    );
  }
  if (!flags.mediaStorage) {
    missing.push('media storage (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET)');
  }
  if (!flags.billing) {
    missing.push('billing (PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY)');
  }
  if (!flags.email) {
    // Required in production: without it, password-reset links cannot be
    // delivered, and the reset flow must never fall back to returning the token
    // in the HTTP response.
    missing.push('email (RESEND_API_KEY, RESEND_FROM_EMAIL)');
  }
  if (!parsed.FRONTEND_URL) {
    missing.push('FRONTEND_URL (required for CORS)');
  }

  if (missing.length > 0) {
    throw new Error(
      `Production environment is missing required integrations: ${missing.join('; ')}`,
    );
  }
}

function loadEnv(): { env: Env; features: Features } {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(formatEnvError(parsed.error));
  }

  const flags = computeFeatures(parsed.data);
  assertProductionIntegrations(parsed.data, flags);

  return { env: parsed.data, features: flags };
}

const loaded = loadEnv();

export const env = loaded.env;
export const features = loaded.features;

/**
 * The value to pass to Fastify's `trustProxy`.
 *
 * Interprets `TRUST_PROXY`: unset/`false` → false (ignore X-Forwarded-For);
 * `true` → true (trust it fully — only safe when nothing untrusted can reach
 * the process); a bare number → that many trusted hops; anything else → passed
 * through as a comma-separated IP/subnet allowlist.
 */
export function trustProxyValue(rawInput?: string): boolean | number | string[] {
  const raw = rawInput ?? env.TRUST_PROXY;
  if (raw === undefined || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;

  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;

  return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Origins permitted by CORS. Empty in production means deny-all (misconfiguration). */
export function allowedOrigins(): string[] {
  if (!env.FRONTEND_URL) {
    return [];
  }
  return env.FRONTEND_URL.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
