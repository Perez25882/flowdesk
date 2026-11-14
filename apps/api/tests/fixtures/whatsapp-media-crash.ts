import { localWhatsAppTransport } from './whatsapp-media-transport.js';

const [phase, id, businessId, origin] = process.argv.slice(2);
if (!id || !businessId || !origin || !process.send)
  throw new Error('Missing crash fixture arguments');
localWhatsAppTransport(origin);

async function pause(): Promise<never> {
  process.send!(phase);
  return new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

if (phase === 'before-message') await pause();
const { dispatchTextReceipts, materializeTextMessage, openTextReceiptQueue } =
  await import('../../src/workers/text-receipt.worker.js');
if (phase === 'after-message') {
  if (!(await materializeTextMessage(id, new Date())))
    throw new Error('Could not link test message');
  await pause();
}
const producer = openTextReceiptQueue();
await dispatchTextReceipts(
  async (data, jobId) => {
    if (phase === 'before-queue') await pause();
    await producer.enqueue(data, jobId);
    if (phase === 'after-queue') await pause();
  },
  new Date(),
  businessId,
);
await producer.close();
throw new Error(`Crash fixture completed without reaching ${phase}`);
