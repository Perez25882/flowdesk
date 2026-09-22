// Vitest global setup: populate the environment with deterministic dummy
// values so modules that import `config/env.ts` (which validates the full env
// schema at import time) can be exercised in unit tests.

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/flowdesk_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test_jwt_secret_value_that_is_at_least_32_chars',
  JWT_REFRESH_SECRET: 'test_refresh_secret_value_at_least_32_chars_long',
  ENCRYPTION_KEY: '0'.repeat(64),
  META_APP_ID: 'test-app-id',
  META_APP_SECRET: 'test_meta_app_secret_at_least_32_chars_long_xx',
  META_VERIFY_TOKEN: 'test-verify-token',
  META_WEBHOOK_SECRET: 'test_meta_webhook_secret_at_least_32_chars_long',
  META_API_VERSION: 'v20.0',
  META_PHONE_NUMBER_ID: 'test-phone-number-id',
  META_ACCESS_TOKEN: 'test-access-token',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  AWS_ACCESS_KEY_ID: 'test-aws-key',
  AWS_SECRET_ACCESS_KEY: 'test-aws-secret',
  AWS_REGION: 'eu-west-1',
  AWS_S3_BUCKET: 'test-bucket',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM_EMAIL: 'test@example.com',
  PAYSTACK_SECRET_KEY: 'sk_test_dummy',
  PAYSTACK_PUBLIC_KEY: 'pk_test_dummy',
  LOG_LEVEL: 'silent',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

/**
 * Forced, not defaulted.
 *
 * Everything above defers to a value already in the environment, which is right
 * for a database URL someone wants to point elsewhere. It is wrong for
 * NODE_ENV: `config/env.ts` validates a different and much stricter set of
 * rules when it reads 'production', so a shell that happens to export
 * NODE_ENV=production makes 31 test files fail to import with an error about
 * Meta credentials and nothing about the real cause.
 *
 * That is not hypothetical — it is where an afternoon went. A test run must
 * validate the same way wherever it runs.
 */
process.env.NODE_ENV = 'test';
