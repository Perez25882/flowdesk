import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound images, and the flag that used to depend on S3.
 *
 * The media block was wrapped in `if (uploadResult)`, so on a deployment with no
 * AWS credentials — which is how the product runs today — an image was never
 * recorded as media, never flagged, and never reviewed. Nothing about deciding
 * "this looks like a payment screenshot" needs the archive: the mime type and
 * the caption arrive with the webhook. These tests hold the two apart.
 *
 * DB-free: BullMQ, Redis, Prisma and S3 are all mocked, and the worker's job
 * handler is pulled out of the mocked `Worker` constructor and called directly.
 */

type JobHandler = (job: { id: string; data: unknown }) => Promise<void>;

const mocks = vi.hoisted(() => ({
  handler: null as JobHandler | null,
  queueAdd: vi.fn().mockResolvedValue(undefined),
  businessFindFirst: vi.fn(),
  messageUpsert: vi.fn(),
  messageUpdate: vi.fn(),
  customerUpsert: vi.fn(),
  orderFindMany: vi.fn(),
  archiveInboundMedia: vi.fn(),
  recordScreenshotClaim: vi.fn(),
  attachScreenshotArchive: vi.fn(),
  emitMessageFlagged: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
  },
  Worker: class {
    constructor(_name: string, handler: JobHandler) {
      mocks.handler = handler;
    }
    on(): void {}
  },
}));

vi.mock('../src/config/redis.js', () => ({ redis: {}, redisSubscriber: {} }));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    business: { findFirst: mocks.businessFindFirst },
    message: { upsert: mocks.messageUpsert, update: mocks.messageUpdate, updateMany: vi.fn() },
    customer: { upsert: mocks.customerUpsert },
    order: { findMany: mocks.orderFindMany },
  },
}));

vi.mock('../src/services/s3/media.js', () => ({
  archiveInboundMedia: mocks.archiveInboundMedia,
  mediaArchiveKey: (businessId: string, waMessageId: string, mimeType: string) =>
    `businesses/${businessId}/media/${waMessageId}.${mimeType.split('/')[1]}`,
}));

vi.mock('../src/modules/payments/screenshot-claims.js', () => ({
  recordScreenshotClaim: mocks.recordScreenshotClaim,
  attachScreenshotArchive: mocks.attachScreenshotArchive,
}));

vi.mock('../src/services/sse/sse.events.js', () => ({
  emitMessageFlagged: mocks.emitMessageFlagged,
}));

vi.mock('../src/workers/dead-letter.worker.js', () => ({
  moveToDeadLetter: vi.fn().mockResolvedValue(undefined),
}));

const { MessageType } = await import('@prisma/client');
await import('../src/workers/message-processor.worker.js');

const ARCHIVE_KEY = 'businesses/biz_1/media/wamid_abc.jpeg';

function imageJob(caption?: string): { id: string; data: unknown } {
  return {
    id: 'job_1',
    data: {
      businessPhoneNumberId: 'phone_1',
      waMessageId: 'wamid_abc',
      receivedAt: new Date().toISOString(),
      message: {
        from: '233209998877',
        timestamp: new Date('2026-08-21T10:00:00Z'),
        type: MessageType.IMAGE,
        ...(caption !== undefined ? { body: caption } : {}),
        media: { id: 'media_1', mimeType: 'image/jpeg', ...(caption !== undefined ? { caption } : {}) },
        rawPayload: {},
      },
    },
  };
}

async function runJob(job: { id: string; data: unknown }): Promise<void> {
  if (!mocks.handler) throw new Error('worker handler was never registered');
  await mocks.handler(job);
}

function mediaUpdates(): Record<string, unknown>[] {
  return mocks.messageUpdate.mock.calls
    .map((call) => (call[0] as { data: Record<string, unknown> }).data)
    .filter((data) => 'mediaType' in data || 'mediaUrl' in data || 'requiresReview' in data);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.businessFindFirst.mockResolvedValue({ id: 'biz_1' });
  mocks.messageUpsert.mockResolvedValue({ id: 'msg_1' });
  mocks.messageUpdate.mockResolvedValue({ id: 'msg_1' });
  mocks.customerUpsert.mockResolvedValue({ id: 'cust_1' });
  mocks.orderFindMany.mockResolvedValue([]);
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.recordScreenshotClaim.mockResolvedValue({ paymentId: 'pay_1', created: true });
  mocks.archiveInboundMedia.mockResolvedValue({
    status: 'unavailable',
    reason: 'storage_not_configured',
  });
});

describe('inbound images when media storage is unconfigured', () => {
  it('records the media type and flags the screenshot anyway', async () => {
    mocks.orderFindMany.mockResolvedValue([{ totalAmount: 450, amountPaid: 0 }]);

    await runJob(imageJob());

    expect(mediaUpdates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mediaType: 'image/jpeg', mediaKey: ARCHIVE_KEY }),
        expect.objectContaining({ requiresReview: true }),
      ]),
    );
    expect(mocks.recordScreenshotClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz_1',
        customerId: 'cust_1',
        screenshotKey: ARCHIVE_KEY,
      }),
    );
    expect(mocks.emitMessageFlagged).toHaveBeenCalledTimes(1);
  });

  it('records a claim with no image attached to it', async () => {
    mocks.orderFindMany.mockResolvedValue([{ totalAmount: 450, amountPaid: 0 }]);

    await runJob(imageJob('I have paid the momo'));

    const claim = mocks.recordScreenshotClaim.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(claim).not.toHaveProperty('screenshotUrl');
    expect(mocks.attachScreenshotArchive).not.toHaveBeenCalled();
  });

  it('still enqueues intent classification', async () => {
    await runJob(imageJob('I have paid'));

    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
  });
});

describe('inbound images once archived', () => {
  it('points the claim at the archived image', async () => {
    mocks.orderFindMany.mockResolvedValue([{ totalAmount: 450, amountPaid: 0 }]);
    mocks.archiveInboundMedia.mockResolvedValue({
      status: 'archived',
      url: 'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg',
      key: ARCHIVE_KEY,
    });

    await runJob(imageJob());

    expect(mocks.recordScreenshotClaim).toHaveBeenCalledTimes(1);
    expect(mocks.attachScreenshotArchive).toHaveBeenCalledWith(
      'biz_1',
      ARCHIVE_KEY,
      'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg',
    );
  });

  it('rescues an image the metadata alone was unsure about, using its shape', async () => {
    // No caption, nothing outstanding — but 1080x2400 is a phone screen, not a
    // photograph, and dimensions only exist once the bytes have been fetched.
    mocks.archiveInboundMedia.mockResolvedValue({
      status: 'archived',
      url: 'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg',
      key: ARCHIVE_KEY,
      dimensions: { width: 1080, height: 2400 },
    });

    await runJob(imageJob());

    expect(mocks.recordScreenshotClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        screenshotKey: ARCHIVE_KEY,
        screenshotUrl: 'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg',
      }),
    );
  });

  it('leaves an ordinary photograph out of the queue', async () => {
    mocks.archiveInboundMedia.mockResolvedValue({
      status: 'archived',
      url: 'https://bucket.s3.eu-west-1.amazonaws.com/x.jpeg',
      key: ARCHIVE_KEY,
      dimensions: { width: 3000, height: 4000 },
    });

    await runJob(imageJob('is this the right bag?'));

    expect(mocks.recordScreenshotClaim).not.toHaveBeenCalled();
    expect(mocks.emitMessageFlagged).not.toHaveBeenCalled();
  });
});

describe('messages that are not images', () => {
  it('are left entirely alone by the media path', async () => {
    const job = imageJob('I want 3 bags of rice');
    (job.data as { message: Record<string, unknown> }).message.type = MessageType.TEXT;

    await runJob(job);

    expect(mocks.archiveInboundMedia).not.toHaveBeenCalled();
    expect(mocks.recordScreenshotClaim).not.toHaveBeenCalled();
  });
});
