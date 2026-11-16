const database = new URL(process.env.DATABASE_URL ?? 'invalid:database');
const cache = new URL(process.env.REDIS_URL ?? 'invalid:cache');
if (database.hostname !== '127.0.0.1' || !database.pathname.startsWith('/flowdesk_g1_') || cache.hostname !== '127.0.0.1' ||
    !cache.port || cache.port === '6379' || !process.send) throw new Error('Disposable fixtures and parent IPC required');

const target = process.argv[2];
const originalFetch = globalThis.fetch;
const charge = process.env.B3_CRASH_CHARGE ? JSON.parse(process.env.B3_CRASH_CHARGE) : null;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (charge && url.hostname === 'api.paystack.co' && url.pathname === '/transaction/verify/' + charge.reference) {
    return Promise.resolve(Response.json({ status: true, data: charge }));
  }
  return originalFetch(input, options);
};

async function probe(point) {
  if (target !== point) return;
  process.send(point);
  await new Promise((resolve) => setTimeout(resolve, 45_000));
}

if (target.includes('settlement') || target.includes('verification')) {
  const { drainPaystackReceipts } = await import('../../dist/modules/payments/paystack-settlement.js');
  await drainPaystackReceipts(process.env.B3_CRASH_BUSINESS, probe);
} else if (target === 'before-reminder-handoff') {
  const { recoverCommerceReminders } = await import('../../dist/modules/commerce/commerce.reminders.js');
  await recoverCommerceReminders(new Date(), probe);
} else if (target === 'after-outbound-intent') {
  const { recoverDurableOutbound } = await import('../../dist/workers/outbound.worker.js');
  await recoverDurableOutbound(probe);
} else {
  const { recoverWorkflows } = await import('../../dist/modules/workflows/workflow.worker.js');
  await recoverWorkflows(new Date(), probe);
}
