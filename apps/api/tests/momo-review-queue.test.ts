import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "needs checking" queue.
 *
 * It used to filter on `screenshotUrl != null`, a column no code path wrote, so
 * the tab was permanently empty and its badge permanently zero — and ordinary
 * unattested payments had nowhere to appear either. These tests pin the two
 * things that fixed it: every live claim is in the queue whatever produced it,
 * and a claim whose image never reached the bucket still shows up, saying so.
 *
 * DB-free: Prisma is mocked at the module boundary and the mapping is what's
 * under test.
 */

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  messageFindMany: vi.fn(),
  paymentFindFirst: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    payment: { findMany: mocks.paymentFindMany, findFirst: mocks.paymentFindFirst },
    message: { findMany: mocks.messageFindMany },
  },
}));

const { Prisma } = await import('@prisma/client');
const { listReviewQueue, findScreenshotKey } = await import(
  '../src/modules/payments/payments.repository.js'
);

const CUSTOMER = { id: 'cust_1', name: 'Emmanuel', waNumber: '233209998877' };

const SCREENSHOT_KEY = 'businesses/biz_1/media/wamid_abc.jpeg';

function screenshotClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_shot',
    amount: new Prisma.Decimal(0),
    method: 'OTHER',
    direction: 'IN',
    confidence: 'CLAIMED',
    reference: null,
    notes: 'Payment screenshot sent on WhatsApp, flagged automatically (confidence 0.65).',
    screenshotKey: SCREENSHOT_KEY,
    screenshotUrl: null,
    createdAt: new Date('2026-08-21T10:00:00Z'),
    customer: CUSTOMER,
    order: null,
    ...overrides,
  };
}

function loggedClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_logged',
    amount: new Prisma.Decimal('250.50'),
    method: 'MOMO_MTN',
    direction: 'IN',
    confidence: 'CLAIMED',
    reference: 'REF123',
    notes: null,
    screenshotKey: null,
    screenshotUrl: null,
    createdAt: new Date('2026-08-21T09:00:00Z'),
    customer: CUSTOMER,
    order: {
      id: 'ord_1',
      referenceNumber: 'FD-00008',
      totalAmount: new Prisma.Decimal('450.00'),
      amountPaid: new Prisma.Decimal('100.00'),
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageFindMany.mockResolvedValue([]);
});

describe('listReviewQueue', () => {
  it('asks only for live claims — voided rows are already resolved', async () => {
    mocks.paymentFindMany.mockResolvedValue([]);

    await listReviewQueue('biz_1', 50);

    expect(mocks.paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: 'biz_1', confidence: 'CLAIMED', voidedAt: null },
        take: 50,
      }),
    );
  });

  it('returns both a flagged screenshot and a hand-logged claim', async () => {
    mocks.paymentFindMany.mockResolvedValue([screenshotClaim(), loggedClaim()]);

    const queue = await listReviewQueue('biz_1', 50);

    expect(queue.map((item) => item.kind)).toEqual(['SCREENSHOT', 'LOGGED']);
  });

  it('reports an unread amount as null rather than as zero', async () => {
    mocks.paymentFindMany.mockResolvedValue([screenshotClaim()]);

    const [item] = await listReviewQueue('biz_1', 50);

    expect(item?.amount).toBeNull();
  });

  it('hands out plain numbers, never Decimal objects', async () => {
    mocks.paymentFindMany.mockResolvedValue([loggedClaim()]);

    const [item] = await listReviewQueue('biz_1', 50);

    expect(item?.amount).toBe(250.5);
    expect(typeof item?.order?.totalAmount).toBe('number');
    expect(item?.order?.outstanding).toBe(350);
  });

  it('still queues a screenshot whose image never reached the bucket, and says so', async () => {
    // The degraded path: no AWS credentials, so the claim exists but the image
    // does not. The owner has to know that rather than see an empty frame.
    mocks.paymentFindMany.mockResolvedValue([screenshotClaim()]);

    const [item] = await listReviewQueue('biz_1', 50);

    expect(item?.screenshot).toEqual(
      expect.objectContaining({
        available: false,
        viewUrl: null,
        unavailableReason: 'NOT_ARCHIVED',
      }),
    );
  });

  it('gives the dashboard a path to fetch an archived image from', async () => {
    mocks.paymentFindMany.mockResolvedValue([
      screenshotClaim({ screenshotUrl: 'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg' }),
    ]);

    const [item] = await listReviewQueue('biz_1', 50);

    expect(item?.screenshot?.available).toBe(true);
    expect(item?.screenshot?.viewUrl).toBe('/payments/pay_shot/screenshot');
  });

  it('carries the caption and arrival time from the message the image came on', async () => {
    mocks.paymentFindMany.mockResolvedValue([screenshotClaim()]);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'msg_1',
        mediaKey: SCREENSHOT_KEY,
        body: 'I have paid 450',
        createdAt: new Date('2026-08-21T09:59:00Z'),
      },
    ]);

    const [item] = await listReviewQueue('biz_1', 50);

    expect(item?.screenshot?.caption).toBe('I have paid 450');
    expect(item?.screenshot?.messageId).toBe('msg_1');
    // Scoped to the tenant: a key alone must never reach another business's row.
    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: 'biz_1', mediaKey: { in: [SCREENSHOT_KEY] } },
      }),
    );
  });

  it('does not look for messages when nothing in the queue has a screenshot', async () => {
    mocks.paymentFindMany.mockResolvedValue([loggedClaim()]);

    await listReviewQueue('biz_1', 50);

    expect(mocks.messageFindMany).not.toHaveBeenCalled();
  });
});

describe('findScreenshotKey', () => {
  it('reports a key that has not been archived as not archived', async () => {
    mocks.paymentFindFirst.mockResolvedValue({
      screenshotKey: SCREENSHOT_KEY,
      screenshotUrl: null,
    });

    expect(await findScreenshotKey('pay_shot', 'biz_1')).toEqual({
      key: SCREENSHOT_KEY,
      archived: false,
    });
  });

  it('returns null for a payment with no screenshot at all', async () => {
    mocks.paymentFindFirst.mockResolvedValue({ screenshotKey: null, screenshotUrl: null });

    expect(await findScreenshotKey('pay_logged', 'biz_1')).toBeNull();
  });
});
