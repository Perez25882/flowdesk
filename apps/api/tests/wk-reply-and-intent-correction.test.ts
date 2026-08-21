import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two defects on the dashboard side of the message module.
 *
 * A second reply to the same inbound message used to be swallowed by BullMQ,
 * because the job carried `jobId: reply-<messageId>` — an id keyed on the
 * conversation slot rather than on the request. An owner sending a correction
 * got a 200 and a customer who never saw it. And a correction to an intent
 * outside the enum reached Prisma, threw a validation error the handler does not
 * map, and came back as "Internal server error".
 */

const mocks = vi.hoisted(() => ({
  messageFindFirst: vi.fn(),
  messageUpdate: vi.fn(),
  messageUpdateMany: vi.fn(),
  intentCorrectionCreate: vi.fn(),
  enqueueOutboundMessage: vi.fn(),
  loadTenantCredentials: vi.fn(),
  canSendOutbound: vi.fn(),
  logActivity: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    message: {
      findFirst: mocks.messageFindFirst,
      update: mocks.messageUpdate,
      updateMany: mocks.messageUpdateMany,
    },
    intentCorrection: { create: mocks.intentCorrectionCreate },
  },
}));

vi.mock('../src/config/redis.js', () => ({
  redis: { set: mocks.redisSet, del: mocks.redisDel },
  redisSubscriber: {},
}));

vi.mock('../src/queues/outbound.queue.js', () => ({
  enqueueOutboundMessage: mocks.enqueueOutboundMessage,
}));

vi.mock('../src/services/whatsapp/client.js', () => ({
  loadTenantCredentials: mocks.loadTenantCredentials,
}));

vi.mock('../src/services/plan/plan.service.js', () => ({
  canSendOutbound: mocks.canSendOutbound,
}));

vi.mock('../src/modules/staff/staff-activity.repository.js', () => ({
  logActivity: mocks.logActivity,
}));

const { sendReply } = await import('../src/modules/messages/messages.service.js');
const { updateMessageIntent } = await import('../src/modules/messages/messages.repository.js');
const { ListMessagesQuerySchema, UpdateMessageIntentSchema } = await import(
  '../src/modules/messages/messages.schema.js'
);
const { NotFoundError } = await import('../src/utils/errors.js');

const REPLYABLE = {
  id: 'msg_1',
  customerId: 'cust_1',
  aiReplyText: null,
  aiReplyStatus: null,
  customer: {
    id: 'cust_1',
    waNumber: '233244123456',
    blacklisted: false,
    lastInboundAt: new Date(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageFindFirst.mockResolvedValue(REPLYABLE);
  mocks.loadTenantCredentials.mockResolvedValue({
    businessId: 'biz_1',
    phoneNumberId: 'phone_1',
    accessToken: 'token',
    businessName: 'Shop',
  });
  mocks.canSendOutbound.mockResolvedValue(true);
  mocks.enqueueOutboundMessage.mockResolvedValue({ queued: true });
  mocks.logActivity.mockResolvedValue(undefined);

  const claimed = new Set<string>();
  mocks.redisSet.mockImplementation(async (key: string) =>
    claimed.has(key) ? null : (claimed.add(key), 'OK'),
  );
  mocks.redisDel.mockImplementation(async (key: string) => (claimed.delete(key) ? 1 : 0));
});

describe('a second reply to the same message', () => {
  it('delivers a correction the owner sends after the first reply', async () => {
    await sendReply('msg_1', 'biz_1', { body: 'That will be GHS 560.' }, 'staff_1');
    const correction = await sendReply(
      'msg_1',
      'biz_1',
      { body: 'Sorry, I meant GHS 620.' },
      'staff_1',
    );

    expect(correction.duplicate).toBe(false);
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueOutboundMessage.mock.calls[1]![0]).toMatchObject({
      body: 'Sorry, I meant GHS 620.',
      inReplyToMessageId: 'msg_1',
    });
  });

  it('passes no idempotency key, so BullMQ can never refuse one silently', async () => {
    await sendReply('msg_1', 'biz_1', { body: 'On its way.' }, null);

    const options = mocks.enqueueOutboundMessage.mock.calls[0]![1];
    expect(options).toBeUndefined();
  });

  it('collapses the identical text submitted twice into one delivery', async () => {
    const first = await sendReply('msg_1', 'biz_1', { body: 'On its way.' }, 'staff_1');
    const second = await sendReply('msg_1', 'biz_1', { body: 'On its way.' }, 'staff_1');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when queueing fails, so the retry is not called a duplicate', async () => {
    mocks.enqueueOutboundMessage.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(sendReply('msg_1', 'biz_1', { body: 'On its way.' }, null)).rejects.toThrow(
      'queue unavailable',
    );

    mocks.enqueueOutboundMessage.mockResolvedValue({ queued: true });
    const retry = await sendReply('msg_1', 'biz_1', { body: 'On its way.' }, null);

    expect(retry.duplicate).toBe(false);
  });

  it('sends anyway when Redis cannot answer', async () => {
    // A duplicate reply is a nuisance. A reply the owner typed that never
    // arrived is the failure the whole function exists to prevent.
    mocks.redisSet.mockRejectedValue(new Error('Redis unavailable'));

    const result = await sendReply('msg_1', 'biz_1', { body: 'On its way.' }, null);

    expect(result.duplicate).toBe(false);
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe('correcting an intent', () => {
  it('accepts a member of the enum', () => {
    expect(UpdateMessageIntentSchema.parse({ intent: 'COMPLAINT' })).toEqual({
      intent: 'COMPLAINT',
    });
  });

  it('rejects a value the column cannot hold, and names what it accepts', () => {
    const parsed = UpdateMessageIntentSchema.safeParse({ intent: 'REFUND' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('ORDER');
  });

  it('rejects an empty intent', () => {
    expect(UpdateMessageIntentSchema.safeParse({ intent: '' }).success).toBe(false);
  });

  it('applies the same narrowing to the list filter', () => {
    expect(ListMessagesQuerySchema.safeParse({ intent: 'ORDER' }).success).toBe(true);
    expect(ListMessagesQuerySchema.safeParse({ intent: 'REFUND' }).success).toBe(false);
  });

  it("is a 404 for another tenant's message id, not a 500", async () => {
    mocks.messageFindFirst.mockResolvedValue(null);

    await expect(
      updateMessageIntent('msg_from_another_shop', 'biz_1', { intent: 'ORDER' as never }, 'owner'),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(mocks.intentCorrectionCreate).not.toHaveBeenCalled();
  });
});
