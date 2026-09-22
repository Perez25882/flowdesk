import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recording the claim a screenshot represents.
 *
 * Meta redelivers webhooks and BullMQ retries jobs, so this code runs more than
 * once for the same image as a matter of routine. One screenshot must produce
 * one claim, and the placeholder figures it starts life with must never look
 * like something anyone asserted.
 */

const mocks = vi.hoisted(() => ({
  paymentFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdateMany: vi.fn(),
  messageFindFirst: vi.fn(),
  messageUpdate: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    payment: {
      findFirst: mocks.paymentFindFirst,
      create: mocks.paymentCreate,
      updateMany: mocks.paymentUpdateMany,
    },
    message: { findFirst: mocks.messageFindFirst, update: mocks.messageUpdate },
  },
}));

const {
  attachScreenshotArchive,
  clearScreenshotReviewFlag,
  guessMethodFromCaption,
  recordScreenshotClaim,
} = await import('../src/modules/payments/screenshot-claims.js');

const SCREENSHOT_KEY = 'businesses/biz_1/media/wamid_abc.jpeg';

const CLAIM = {
  businessId: 'biz_1',
  customerId: 'cust_1',
  screenshotKey: SCREENSHOT_KEY,
  caption: null,
  detectionConfidence: 0.65,
  reasons: ['the customer has an order with money outstanding'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paymentFindFirst.mockResolvedValue(null);
  mocks.paymentCreate.mockResolvedValue({ id: 'pay_1' });
});

describe('recordScreenshotClaim', () => {
  it('records an unverified claim with no amount and no attester', async () => {
    await recordScreenshotClaim(CLAIM);

    const data = (mocks.paymentCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      businessId: 'biz_1',
      customerId: 'cust_1',
      confidence: 'CLAIMED',
      direction: 'IN',
      screenshotKey: SCREENSHOT_KEY,
    });
    expect(Number(data.amount)).toBe(0);
    expect(data).not.toHaveProperty('attestedBy');
    // The detector's reasoning rides along, so a dismissal can be explained.
    expect(String(data.notes)).toContain('0.65');
  });

  it('does not record a second claim when the same message is processed again', async () => {
    mocks.paymentFindFirst.mockResolvedValue({ id: 'pay_1' });

    const result = await recordScreenshotClaim(CLAIM);

    expect(result).toEqual({ paymentId: 'pay_1', created: false });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it('looks the existing claim up by the archive key, which is stable per message', async () => {
    await recordScreenshotClaim(CLAIM);

    expect(mocks.paymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: 'biz_1', screenshotKey: SCREENSHOT_KEY },
      }),
    );
  });
});

describe('guessMethodFromCaption', () => {
  it('takes the network from the customer when they name it', () => {
    expect(guessMethodFromCaption('sent via MTN momo')).toBe('MOMO_MTN');
    expect(guessMethodFromCaption('telecel cash sent')).toBe('MOMO_VODAFONE');
    expect(guessMethodFromCaption('airteltigo money')).toBe('MOMO_AIRTELTIGO');
  });

  it('guesses nothing when they did not say', () => {
    // Inventing MTN because it is the commonest network would put a fabricated
    // method one tap away from being attested and counted.
    expect(guessMethodFromCaption(null)).toBe('OTHER');
    expect(guessMethodFromCaption('here')).toBe('OTHER');
  });
});

describe('attachScreenshotArchive', () => {
  it('is scoped to the tenant as well as the key', async () => {
    await attachScreenshotArchive('biz_1', SCREENSHOT_KEY, 'https://bucket/x.jpeg');

    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { businessId: 'biz_1', screenshotKey: SCREENSHOT_KEY },
      data: { screenshotUrl: 'https://bucket/x.jpeg' },
    });
  });
});

describe('clearScreenshotReviewFlag', () => {
  it('clears the flag on the message the screenshot arrived on', async () => {
    mocks.messageFindFirst.mockResolvedValue({ id: 'msg_1', aiReplyStatus: null });

    await clearScreenshotReviewFlag('biz_1', SCREENSHOT_KEY);

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: { requiresReview: false },
    });
  });

  it('leaves the flag alone when the message is carrying an unsent draft', async () => {
    mocks.messageFindFirst.mockResolvedValue({ id: 'msg_1', aiReplyStatus: 'DRAFT' });

    await clearScreenshotReviewFlag('biz_1', SCREENSHOT_KEY);

    expect(mocks.messageUpdate).not.toHaveBeenCalled();
  });

  it('swallows a database failure — this is queue hygiene, not the money path', async () => {
    mocks.messageFindFirst.mockRejectedValue(new Error('connection lost'));

    await expect(clearScreenshotReviewFlag('biz_1', SCREENSHOT_KEY)).resolves.toBeUndefined();
  });
});
