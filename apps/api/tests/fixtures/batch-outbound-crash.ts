const id = process.argv[2];
if (!id || !process.send) throw new Error('Run this fixture as a subprocess with a send ID');
const database = new URL(process.env.DATABASE_URL ?? '');
const redis = new URL(process.env.REDIS_URL ?? '');
if (database.hostname !== '127.0.0.1' || !database.pathname.startsWith('/flowdesk_g1_') ||
    redis.hostname !== '127.0.0.1' || !redis.port || redis.port === '6379') throw new Error('Disposable fixtures required');

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== 'graph.facebook.com' || !url.pathname.endsWith('/messages') ||
      JSON.parse(String(init?.body)).biz_opaque_callback_data !== id) throw new Error('Unexpected fixture provider request');
  process.send?.('provider-request');
  return new Promise<Response>(() => {});
};

const { processDurableOutbound } = await import('../../src/workers/outbound.worker.js');
await processDurableOutbound(id);
throw new Error('Worker returned before the expected interruption');
