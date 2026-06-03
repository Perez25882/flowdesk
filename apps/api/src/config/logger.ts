import pino from 'pino';
import { env } from './env.js';

const isDevelopment = env.NODE_ENV === 'development';
const isTest = env.NODE_ENV === 'test';

const loggerOptions: Parameters<typeof pino>[0] = {
  level: isTest ? 'silent' : env.LOG_LEVEL,
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
