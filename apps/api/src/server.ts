import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { messageProcessorWorker } from './workers/message-processor.worker.js';
import { intentClassifierWorker } from './workers/intent-classifier.worker.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function drainQueues(): Promise<void> {
  await messageProcessorWorker.close();
  await intentClassifierWorker.close();
  logger.info('Queue drain completed');
}

async function startServer(): Promise<void> {
  const app = await createApp();

  await connectDatabase();
  await connectRedis();

  let isShuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');

    const shutdownTimeout = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await app.close();
      await drainQueues();
      await disconnectRedis();
      await disconnectDatabase();
      clearTimeout(shutdownTimeout);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error: unknown) {
      clearTimeout(shutdownTimeout);
      logger.error({ error }, 'Graceful shutdown failed');
      process.exit(1);
    }
  }

  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT }, 'Flowdesk API server started');
}

startServer().catch((error: unknown) => {
  logger.error({ error }, 'Failed to start Flowdesk API server');
  process.exit(1);
});
