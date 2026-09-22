import { logger } from '../config/logger.js';
import { redis } from '../config/redis.js';

/**
 * Stops one busy shop from consuming every worker slot.
 *
 * Intent classification is almost entirely waiting on a model, so concurrency
 * can be high — but raising it alone just means one shop with fifty queued
 * messages occupies all of them, and every other tenant's customers wait behind
 * a queue that has nothing to do with them. BullMQ's per-group concurrency is a
 * paid feature, so this is the poor-man's version: a counter per tenant.
 *
 * Deliberately best-effort. If a tenant is at its cap the job waits briefly and
 * then runs anyway, because a late reply beats a dropped one, and a fairness
 * mechanism that can strand messages is worse than none. Redis being unavailable
 * has the same outcome: the work goes ahead.
 */

/** Slots one tenant may occupy at once. Roughly a third of worker concurrency. */
const MAX_IN_FLIGHT_PER_TENANT = 3;

/** How long to wait for a slot before going ahead regardless. */
const MAX_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 400;

/**
 * Long enough to outlive the slowest model call, short enough that a crashed
 * worker's leaked slot frees itself rather than throttling a tenant forever.
 */
const SLOT_TTL_SECONDS = 60;

function slotKey(businessId: string): string {
  return `flowdesk:intent:inflight:${businessId}`;
}

async function currentInFlight(businessId: string): Promise<number> {
  const raw = await redis.get(slotKey(businessId));
  return raw ? Number(raw) : 0;
}

/**
 * Takes a slot for this tenant, waiting a little if they are at their cap.
 *
 * Returns a release function. Always call it — a leaked slot only clears when
 * the TTL expires, and until then that tenant runs one slot short.
 */
export async function withTenantSlot<T>(
  businessId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = slotKey(businessId);
  const deadline = Date.now() + MAX_WAIT_MS;

  try {
    while ((await currentInFlight(businessId)) >= MAX_IN_FLIGHT_PER_TENANT) {
      if (Date.now() >= deadline) {
        logger.debug(
          { businessId, cap: MAX_IN_FLIGHT_PER_TENANT },
          'Tenant at its concurrency cap — proceeding anyway rather than delaying further',
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const count = await redis.incr(key);
    // Only the first holder sets the expiry, so a steady stream of work does not
    // keep pushing the TTL out and turn a leak into a permanent throttle.
    if (count === 1) await redis.expire(key, SLOT_TTL_SECONDS);
  } catch {
    // No counter available: run unthrottled rather than blocking the pipeline.
    logger.warn({ businessId }, 'Tenant fairness counter unavailable — running unthrottled');
    return work();
  }

  try {
    return await work();
  } finally {
    try {
      // Floor at zero: a TTL expiry mid-flight would otherwise leave the counter
      // negative and hand that tenant extra slots indefinitely.
      const remaining = await redis.decr(key);
      if (remaining < 0) await redis.del(key);
    } catch {
      // The TTL cleans up.
    }
  }
}
