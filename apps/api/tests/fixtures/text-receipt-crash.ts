import {
  dispatchTextReceipts,
  openTextReceiptQueue,
} from '../../src/workers/text-receipt.worker.js';

const phase = process.argv[2];
const target = process.argv[3];
if (
  !process.send ||
  !target ||
  !['before-enqueue', 'after-enqueue'].includes(phase ?? '') ||
  !process.env.G1_TEST_DATABASE_URL ||
  !process.env.G1_TEST_REDIS_URL ||
  process.env.DATABASE_URL !== process.env.G1_TEST_DATABASE_URL ||
  process.env.REDIS_URL !== process.env.G1_TEST_REDIS_URL
) {
  throw new Error('Use this fixture through the local text receipt integration suite');
}
const producer = openTextReceiptQueue();

await dispatchTextReceipts(async (job, jobId) => {
  if (job.waMessageId !== target) return producer.enqueue(job, jobId);
  if (phase === 'after-enqueue') await producer.enqueue(job, jobId);
  process.send!(phase);
  // The parent kills this process while the real Postgres handoff transaction is open.
  await new Promise(() => {});
});
