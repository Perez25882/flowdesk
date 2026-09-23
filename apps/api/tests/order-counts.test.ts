import { describe, expect, it } from 'vitest';
import { fillStatusCounts } from '../src/modules/orders/orders.repository.js';

/**
 * How many orders are in each state — the numbers on the Orders tabs.
 *
 * The board used to count what it had FETCHED, and it fetched the API's
 * default page of 20 per status without saying so. A shop with 180 pending
 * orders saw a column headed "20" holding twenty cards, and the other 160 were
 * not on screen anywhere. These counts come from the database, so a tab says
 * how many orders there really are.
 */

describe('fillStatusCounts', () => {
  it('reports every status, including ones with no orders', () => {
    // A status nobody is in still has to appear as a tab, reading zero, rather
    // than vanishing and moving every other tab along.
    const counts = fillStatusCounts([{ status: 'PENDING', _count: { _all: 3 } }]);

    expect(counts).toEqual({
      ALL: 3,
      PENDING: 3,
      CONFIRMED: 0,
      PROCESSING: 0,
      DISPATCHED: 0,
      FULFILLED: 0,
      CANCELLED: 0,
    });
  });

  it('totals every status into ALL', () => {
    const counts = fillStatusCounts([
      { status: 'PENDING', _count: { _all: 180 } },
      { status: 'FULFILLED', _count: { _all: 40 } },
      { status: 'CANCELLED', _count: { _all: 5 } },
    ]);

    expect(counts.ALL).toBe(225);
    expect(counts.PENDING).toBe(180);
  });

  it('reads zero everywhere for a shop with no orders', () => {
    const counts = fillStatusCounts([]);

    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
  });
});
