import pino from 'pino';
import { env } from './env.js';

const isDevelopment = env.NODE_ENV === 'development';
const isTest = env.NODE_ENV === 'test';

/**
 * Field names that must never reach a log line, wherever they appear.
 *
 * A backstop, not a licence: the first defence is not putting a secret or a
 * customer's details in the log object at all. But log objects are assembled in
 * a hundred places and whole records get spread into them (`{ ...business }`,
 * `{ err }` with a request attached), so a single forgotten spread was enough
 * to write a bcrypt hash or a live WhatsApp access token into the production
 * log — where it outlives the incident it was logged for and is readable by
 * anyone with log access.
 *
 * Each name is listed at the top level and at two levels of nesting, because
 * pino's redaction paths are literal: `password` does not match
 * `body.password`, and `*` matches exactly one level.
 */
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'waAccessToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
] as const;

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

const loggerOptions: Parameters<typeof pino>[0] = {
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
};

if (isDevelopment) {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(loggerOptions);
