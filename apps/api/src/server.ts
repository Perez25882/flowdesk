import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { syncAccessTokenFromEnv } from './services/whatsapp/sync-token.js';
import { startSSEFanout, stopSSEFanout } from './services/sse/sse.manager.js';
import { messageProcessorWorker } from './workers/message-processor.worker.js';
import { intentClassifierWorker } from './workers/intent-classifier.worker.js';
import { outboundWorker } from './workers/outbound.worker.js';
import { deadLetterWorker } from './workers/dead-letter.worker.js';
import { insightsWorker } from './workers/insights.worker.js';
import { scheduleDailyInsights } from './queues/insights.queue.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function drainQueues(): Promise<void> {
  // Closed in pipeline order so in-flight work can finish downstream rather
  // than being orphaned mid-way.
  await messageProcessorWorker.close();
  await intentClassifierWorker.close();
  await outboundWorker.close();
  await deadLetterWorker.close();
  await insightsWorker.close();
  logger.info('Queue drain completed');
}

async function startServer(): Promise<void> {
  const app = await createApp();

  await connectDatabase();
  await connectRedis();

  // Must run before traffic is accepted: a dashboard connecting to this
  // instance would otherwise miss events raised on any other instance.
  await startSSEFanout();

  await syncAccessTokenFromEnv().catch((error: unknown) => {
    logger.error({ error }, 'Failed to sync WhatsApp access token from environment');
  });

  // Keyed by name and pattern in Redis, so every instance calling this
  // converges on one schedule rather than one each. A failure here must not
  // stop the server: the summaries are a courtesy, the message pipeline is not.
  await scheduleDailyInsights().catch((error: unknown) => {
    logger.error({ error }, 'Failed to install the daily summary schedule');
  });

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
      await stopSSEFanout();
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
