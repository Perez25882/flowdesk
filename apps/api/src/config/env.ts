import { config } from 'dotenv';
import { z } from 'zod';

config();

const REQUIRED_SECRET_MIN_LENGTH = 32;
const DEFAULT_HAIKU_CONFIDENCE_THRESHOLD = 0.75;

const booleanFromString = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.toLowerCase() === 'true';
}, z.boolean());

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid connection URL'),
  JWT_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  JWT_REFRESH_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  META_VERIFY_TOKEN: z.string().min(1),
  META_WEBHOOK_SECRET: z.string().min(REQUIRED_SECRET_MIN_LENGTH),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'META_API_VERSION must look like v20.0'),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().email('RESEND_FROM_EMAIL must be a valid email address'),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PUBLIC_KEY: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  FRONTEND_URL: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
  HAIKU_FALLBACK_ENABLED: booleanFromString.default(true),
  HAIKU_CONFIDENCE_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_HAIKU_CONFIDENCE_THRESHOLD),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function formatEnvError(error: z.ZodError): string {
  const formattedIssues = error.issues
    .map((issue) => {
      const path = issue.path.join('.') || 'environment';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  return `Invalid environment configuration: ${formattedIssues}`;
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(formatEnvError(parsed.error));
  }

  return parsed.data;
}

export const env = loadEnv();
