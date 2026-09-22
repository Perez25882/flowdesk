import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A confirmed time is a time that exists.
 *
 * `bookingOfferStatus` is a real server-side gate: it refuses any instant that
 * is not in the set of slots the server itself computed. But it only ever
 * decided whether the REPLY could be auto-sent. `book()` — the function that
 * owns the `appointments_no_overlap` exclusion constraint — was called from
 * exactly one place, the manual dashboard. The assistant never called it.
 *
 * So the assistant could tell a stranger "yes, you're booked for Tuesday at
 * 2pm", pass every check, and write nothing. Two customers could each be told
 * the same slot was theirs, and the owner's diary would show neither. The
 * database guard that `booking-offer.ts`'s own docstring relies on never
 * engaged, because the write path that owns it was never reached.
 *
 * The ordering is the security property: the row is taken BEFORE the
 * confirmation is sent. A booking that loses the race must not produce a
 * message saying it won.
 */

const mocks = vi.hoisted(() => ({
  book: vi.fn(),
}));

vi.mock('../src/modules/bookings/bookings.service.js', () => ({ book: mocks.book }));

const { settleBooking } = await import('../src/services/assistant/index.js');

const BUSINESS_ID = 'biz_1';
const CUSTOMER_ID = 'cus_1';
const SERVICE_ID = 'svc_1';
const STARTS_AT = '2026-09-22T14:30:00.000Z';

const AUTHORISED = { serviceId: SERVICE_ID, startsAt: STARTS_AT };

beforeEach(() => {
  mocks.book.mockReset().mockResolvedValue({ id: 'apt_1', reference: 'APT-1' });
});

describe('settleBooking', () => {
  it('takes the slot the assistant confirmed', async () => {
    const taken = await settleBooking(AUTHORISED, BUSINESS_ID, CUSTOMER_ID);

    expect(taken).toBe(true);
    expect(mocks.book).toHaveBeenCalledTimes(1);

    const [input] = mocks.book.mock.calls[0]!;
    expect(input).toMatchObject({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      byAssistant: true,
    });
    // Passed as an instant, not a string, so the exclusion constraint compares
    // the same moment the slot gate checked.
    expect((input as { startsAt: Date }).startsAt.toISOString()).toBe(STARTS_AT);
  });

  it('reports failure when the slot was taken in the race', async () => {
    // The caller must not send "you're booked" on the back of this.
    mocks.book.mockRejectedValue(new Error('appointments_no_overlap'));

    const taken = await settleBooking(AUTHORISED, BUSINESS_ID, CUSTOMER_ID);

    expect(taken).toBe(false);
  });

  it('does nothing when no booking was authorised', async () => {
    const taken = await settleBooking(null, BUSINESS_ID, CUSTOMER_ID);

    expect(taken).toBe(true);
    expect(mocks.book).not.toHaveBeenCalled();
  });
});
