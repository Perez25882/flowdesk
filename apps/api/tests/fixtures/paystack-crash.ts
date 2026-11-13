import { prisma } from '../../src/config/database.js';
import { claimPaystackReceipt } from '../../src/modules/payments/paystack-receipts.js';
import { processPaystackReceipt } from '../../src/modules/payments/paystack-settlement.js';

const [phase, businessId, origin] = process.argv.slice(2);
if (!businessId || !origin || new URL(origin).hostname !== '127.0.0.1') throw new Error('Expected a loopback fixture');

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'api.paystack.co') return fetchOriginal(new URL(url.pathname, origin), options);
  return fetchOriginal(input, options);
};

const receipt = await claimPaystackReceipt(businessId);
if (!receipt) throw new Error('No due receipt in the synthetic business');
if (phase === 'before-verify') process.send?.('claimed');
else {
  await processPaystackReceipt(receipt);
  const result = await prisma.paystackReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
  process.send?.(result.state);
}

// The parent terminates the real process at the chosen interruption point.
setInterval(() => {}, 1000);
