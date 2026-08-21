import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaWebhookPayload } from '../src/modules/webhook/webhook.types.js';
import {
  duplicateMessagePayload,
  textMessagePayload,
} from './fixtures/meta-webhook-payloads.js';
import {
  broadcasts,
  db,
  meta,
  queues,
  redis,
  resetHarness,
  type FakeJob,
} from './wk-pipeline-harness.js';

/**
 * The first test that runs more than one unit.
 *
 * Everything else in this suite exercises a function. This drives a Meta webhook
 * through the real route, the real message processor, the real classifier, the
 * real notification layer, the real outbound worker and the real WhatsApp client
 * — wired to each other exactly as they are in production — and looks at what
 * comes out the far end: the rows that were written, the job that was queued,
 * the SSE event that was broadcast and the request that reached Meta. Every P0
 * this suite has found lived in the wiring between two units that were each
 * correct on their own, and no unit test could have seen any of them.
 *
 * WHAT IS FAKED, and why each one is a seam rather than a hole:
 *
 *   `config/database.js`  an in-memory store that records every write. It
 *                         answers Prisma's call shapes; it is not Postgres.
 *   `config/redis.js`     an in-memory store. TTLs do not elapse.
 *   `bullmq`              queues that hand each job straight to the real worker
 *                         handler, in process, one at a time.
 *   `fetch`               records what the WhatsApp client sent to Meta.
 *   `assistant/index.js`  stubbed per test. The assistant has its own suite; what
 *                         matters here is WHEN it runs and what it sends.
 *   `orders.service.js`   `createOrderFromMessage` writes an order row and hands
 *                         it back. Order building is unit-tested elsewhere.
 *   `sse.manager.js`      records broadcasts. `sse.events.ts` is the real thing.
 *
 * WHAT THIS THEREFORE CANNOT CATCH, and needs a real database for:
 *
 *   - Constraint violations. `Message.waMessageId` is unique in Postgres and is
 *     not here, so the dedupe test below proves the Redis claim and the upsert
 *     agree, not that the index would have caught a third path.
 *   - Concurrency. Every job runs to completion before the next starts, so a
 *     lost update, a deadlock or two workers racing the same row is invisible.
 *   - Transactions and isolation. Nothing here rolls back.
 *   - Prisma's own validation. A wrong enum value or a missing required column
 *     is accepted here and rejected in production — which is exactly the shape
 *     of defect 4.
 *   - Anything that depends on a TTL expiring, since none do.
 */

// The rule engine is what this pipeline should be exercising; the Haiku fallback
// would reach for the network on a low-confidence message. Set before anything
// imports `config/env.ts`, which validates and freezes the environment.
process.env.HAIKU_FALLBACK_ENABLED = 'false';

const mocks = vi.hoisted(() => ({
  runAssistant: vi.fn(),
  createOrderFromMessage: vi.fn(),
}));

vi.mock('bullmq', async () => {
  const harness = await import('./wk-pipeline-harness.js');
  return {
    Queue: harness.FakeQueue,
    Worker: harness.FakeWorker,
    UnrecoverableError: harness.UnrecoverableError,
  };
});

vi.mock('../src/config/database.js', async () => {
  const harness = await import('./wk-pipeline-harness.js');
  return { prisma: harness.db.client };
});

vi.mock('../src/config/redis.js', async () => {
  const harness = await import('./wk-pipeline-harness.js');
  return {
    redis: harness.redis,
    redisSubscriber: harness.redis,
    rateLimitRedis: harness.redis,
    sseSubscriber: harness.redis,
    connectRedis: async (): Promise<void> => undefined,
    disconnectRedis: async (): Promise<void> => undefined,
  };
});

vi.mock('../src/services/sse/sse.manager.js', async () => {
  const harness = await import('./wk-pipeline-harness.js');
  return { SSEManager: harness.SSEManager };
});

vi.mock('../src/services/assistant/index.js', () => ({
  runAssistant: mocks.runAssistant,
}));

vi.mock('../src/modules/orders/orders.service.js', () => ({
  createOrderFromMessage: mocks.createOrderFromMessage,
}));

const { default: webhookRoutes } = await import('../src/modules/webhook/webhook.route.js');
const { deliverText, loadNotificationContext } = await import(
  '../src/services/notifications/customer-notifications.js'
);

// Importing a worker is what registers it with the queue harness, so the order
// below is the order the pipeline runs in.
await import('../src/workers/message-processor.worker.js');
await import('../src/workers/intent-classifier.worker.js');
await import('../src/workers/outbound.worker.js');

const BUSINESS_ID = 'biz_1';
const BUSINESS_NAME = 'Accra Rice Depot';
const ACCESS_TOKEN = 'tenant-access-token';
const WA_MESSAGE_ID = 'wamid.abcdefghijklmnopqrstuvwxyz1';
const CUSTOMER_NUMBER = '233244123456';

let app: FastifyInstance;

/**
 * The same fixture, delivered as if it had just arrived.
 *
 * The stored payload is timestamped in 2024, which puts every customer it
 * creates outside Meta's 24-hour window — useful for exactly one of the tests
 * below and wrong for the rest, so the timestamp is the only thing moved.
 */
function asJustArrived(payload: MetaWebhookPayload): MetaWebhookPayload {
  const copy = structuredClone(payload) as MetaWebhookPayload;

  for (const entry of copy.entry) {
    for (const change of entry.changes) {
      for (const message of change.value.messages ?? []) {
        message.timestamp = String(Math.floor(Date.now() / 1000));
      }
    }
  }

  return copy;
}

function withBody(payload: MetaWebhookPayload, body: string): MetaWebhookPayload {
  const copy = structuredClone(payload) as MetaWebhookPayload;
  const message = copy.entry[0]!.changes[0]!.value.messages![0]!;
  if (message.type === 'text') message.text.body = body;
  return copy;
}

async function deliverWebhook(payload: MetaWebhookPayload): Promise<{
  statusCode: number;
  body: { data: { processed: number; enqueued: number; echoed: number } };
}> {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', process.env.META_WEBHOOK_SECRET!)
    .update(raw)
    .digest('hex');

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/webhook',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
  });

  return { statusCode: response.statusCode, body: response.json() };
}

function seedBusiness(overrides: Record<string, unknown> = {}): void {
  const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  db.seed('business', {
    id: BUSINESS_ID,
    name: BUSINESS_NAME,
    waPhoneNumberId: 'phone-number-id-1',
    waAccessToken: ACCESS_TOKEN,
    waConnectionState: 'ACTIVE',
    plan: 'STARTER',
    convoCountResetAt: nextMonth,
    orderCountResetAt: nextMonth,
    ...overrides,
  });

  db.seed('product', {
    id: 'prod_1',
    businessId: BUSINESS_ID,
    name: 'Rice',
    aliases: ['bag of rice'],
    unit: 'bag',
    price: 320,
  });
}

function inboundMessage(): Record<string, unknown> | undefined {
  return db.table('message').find((row) => row.waMessageId === WA_MESSAGE_ID);
}

function outboundJobs(): FakeJob[] {
  return queues.added('outbound-messages');
}

beforeAll(async () => {
  app = Fastify();
  await app.register(import('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    runFirst: true,
  });
  await app.register(webhookRoutes, { prefix: '/api/v1' });
  await app.ready();
});

beforeEach(() => {
  resetHarness();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', meta.fetch);

  mocks.runAssistant.mockResolvedValue({
    action: 'template_reply',
    escalated: false,
    intent: null,
    confidence: null,
  });

  mocks.createOrderFromMessage.mockImplementation(
    async (body: string, businessId: string, customerId: string) =>
      db.seed('order', {
        id: 'order_1',
        businessId,
        customerId,
        referenceNumber: 'FD-1042',
        status: 'PENDING',
        totalAmount: 640,
        rawMessage: body,
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a text order message, webhook to WhatsApp', () => {
  it('records the customer, classifies the message, creates the order and confirms it', async () => {
    seedBusiness();

    const response = await deliverWebhook(asJustArrived(textMessagePayload));
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ processed: 1, enqueued: 1, echoed: 0 });

    await queues.drain();

    // The customer is created from the webhook's contact block, and the message
    // is what opens Meta's service window for them.
    const customer = db.table('customer').find((row) => row.waNumber === CUSTOMER_NUMBER);
    expect(customer).toMatchObject({ businessId: BUSINESS_ID, name: 'Kwame Mensah' });
    expect(customer?.lastInboundAt).toBeInstanceOf(Date);

    const inbound = inboundMessage();
    expect(inbound).toMatchObject({
      businessId: BUSINESS_ID,
      customerId: customer?.id,
      direction: 'INBOUND',
      intent: 'ORDER',
      processed: true,
      relatedOrderId: 'order_1',
    });

    // The order was built from the message, and exactly one confirmation went
    // out for it — the contract between `createOrderFromMessage` (which
    // deliberately does not reply) and the intent worker (which does).
    expect(mocks.createOrderFromMessage).toHaveBeenCalledTimes(1);
    expect(mocks.createOrderFromMessage).toHaveBeenCalledWith(
      'Hello, I want to order 2 bags of rice',
      BUSINESS_ID,
      customer?.id,
    );

    const queued = outboundJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toMatchObject({
      businessId: BUSINESS_ID,
      customerId: customer?.id,
      to: CUSTOMER_NUMBER,
      templateKey: 'order_pending',
      relatedOrderId: 'order_1',
    });
    expect(queued[0]!.data.body).toBe(
      `Hi Kwame! We received your order (Ref: FD-1042). We'll confirm shortly. — ${BUSINESS_NAME}`,
    );
    // Inside the window there is no template on the job: free-form carries the
    // owner's own wording, an approved template cannot.
    expect(queued[0]!.data.template).toBeUndefined();

    // And it reached Meta, through this tenant's own credentials.
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]!.token).toBe(ACCESS_TOKEN);
    expect(meta.calls[0]!.url).toContain('phone-number-id-1/messages');
    expect(meta.calls[0]!.body).toMatchObject({ type: 'text', to: CUSTOMER_NUMBER });

    // The sent copy is in the conversation log and counted against the plan.
    const sent = db.table('message').find((row) => row.direction === 'OUTBOUND');
    expect(sent).toMatchObject({ waMessageId: 'wamid.sent-1', processed: true });
    expect(db.table('business')[0]!.monthlyConvoCount).toBe(1);
  });

  it('broadcasts message.flagged for a message a person has to see', async () => {
    seedBusiness();

    // A complaint is reviewed by a person whatever the assistant does, so this
    // is the path from the classifier's verdict to the dashboard.
    await deliverWebhook(
      withBody(asJustArrived(textMessagePayload), 'Terrible service, very disappointed'),
    );
    await queues.drain();

    expect(inboundMessage()).toMatchObject({ intent: 'COMPLAINT', requiresReview: true });

    const flagged = broadcasts.filter((event) => event.type === 'message.flagged');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      businessId: BUSINESS_ID,
      payload: { messageId: inboundMessage()?.id, requiresReview: true, intent: 'COMPLAINT' },
    });
  });
});

describe('the same webhook delivered twice', () => {
  it('processes it once and sends one reply', async () => {
    seedBusiness();

    const payload = asJustArrived(textMessagePayload);
    const first = await deliverWebhook(payload);

    // Meta's retry: the same message id, delivered again.
    const retry = asJustArrived(duplicateMessagePayload);
    const second = await deliverWebhook(retry);

    await queues.drain();

    expect(first.body.data).toEqual({ processed: 1, enqueued: 1, echoed: 0 });
    expect(second.body.data).toEqual({ processed: 1, enqueued: 0, echoed: 0 });

    expect(queues.added('incoming-messages')).toHaveLength(1);
    expect(db.table('message').filter((row) => row.waMessageId === WA_MESSAGE_ID)).toHaveLength(1);
    expect(mocks.createOrderFromMessage).toHaveBeenCalledTimes(1);
    expect(meta.calls).toHaveLength(1);
  });

  it('still processes it once when the webhook dedupe claim is unavailable', async () => {
    seedBusiness();

    // Redis down. The route lets the message through rather than dropping it,
    // and the queue's job id is the guard that has to hold instead.
    const payload = asJustArrived(textMessagePayload);
    redis.failing = true;

    await deliverWebhook(payload);
    await deliverWebhook(asJustArrived(duplicateMessagePayload));

    redis.failing = false;
    await queues.drain();

    expect(queues.added('incoming-messages')).toHaveLength(1);
    expect(meta.calls).toHaveLength(1);
  });
});

describe('a retry after the assistant has already answered', () => {
  it('does not answer the customer a second time', async () => {
    seedBusiness();

    // The assistant asks a question and sends it from inside itself, exactly as
    // the real one does, and then the write that follows it dies — a pool
    // timeout, a reset connection, a deadlock. This is the audit's concrete
    // case: without the guard the retry re-ran the whole job and asked the same
    // question again, with the clarification counter now reading two.
    mocks.runAssistant.mockImplementation(
      async (input: { businessId: string; customerId: string }) => {
        const context = await loadNotificationContext(input.businessId, input.customerId);
        if (context) await deliverText(context, 'Which size — 5kg or 25kg?');
        return { action: 'clarify', escalated: false, intent: 'ORDER', confidence: 0.9 };
      },
    );

    db.failNextWrite(
      'message',
      'update',
      (data) => 'requiresReview' in data && !('processed' in data),
    );

    await deliverWebhook(asJustArrived(textMessagePayload));
    await queues.drain();

    // The customer has been answered, and the job failed after answering them.
    expect(mocks.runAssistant).toHaveBeenCalledTimes(1);
    expect(outboundJobs()).toHaveLength(1);
    expect(meta.calls).toHaveLength(1);

    const failed = queues.failures.filter((entry) => entry.job.queue === 'intent-classification');
    expect(failed).toHaveLength(1);

    // BullMQ hands the identical job back.
    await queues.run(failed[0]!.job);
    await queues.drain();

    expect(mocks.runAssistant).toHaveBeenCalledTimes(1);
    expect(outboundJobs()).toHaveLength(1);
    expect(meta.calls).toHaveLength(1);

    // Nothing is dropped quietly: the retry could not tell how far the first
    // attempt got, so the message goes in front of the owner.
    expect(inboundMessage()).toMatchObject({ requiresReview: true });
    expect(broadcasts.some((event) => event.type === 'message.flagged')).toBe(true);
  });
});

describe('a send outside the 24-hour service window', () => {
  it('goes out as an approved template instead of being dropped', async () => {
    seedBusiness();

    // The fixture's own timestamp is more than a day old, so the window this
    // message opens has already closed by the time the reply is composed.
    await deliverWebhook(textMessagePayload);
    await queues.drain();

    const queued = outboundJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data.template).toEqual({
      name: 'flowdesk_order_pending',
      language: 'en',
      parameters: ['Kwame', 'FD-1042', BUSINESS_NAME],
    });

    // The rendered text still rides along, because that is what the
    // conversation log shows the owner.
    expect(queued[0]!.data.body).toContain('FD-1042');

    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'flowdesk_order_pending',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Kwame' },
              { type: 'text', text: 'FD-1042' },
              { type: 'text', text: BUSINESS_NAME },
            ],
          },
        ],
      },
    });

    // Meta bills a template conversation the same way, so it is recorded the
    // same way.
    expect(db.table('message').filter((row) => row.direction === 'OUTBOUND')).toHaveLength(1);
    expect(db.table('business')[0]!.monthlyConvoCount).toBe(1);
  });

  it('dead-letters a template the tenant has not had approved, rather than pretending', async () => {
    seedBusiness();

    // 132001: the template does not exist on this WhatsApp Business Account
    // yet. Every newly onboarded tenant hits this until an operator creates it.
    meta.failNextWith(132001, 'Template name does not exist in the translation');

    await deliverWebhook(textMessagePayload);
    await queues.drain();

    // Tried once. A missing template does not appear part-way through a retry
    // budget, so the send is not retried.
    expect(meta.calls).toHaveLength(1);

    // Nothing claims the customer was reached.
    expect(db.table('message').filter((row) => row.direction === 'OUTBOUND')).toHaveLength(0);
    expect(db.table('business')[0]!.monthlyConvoCount).toBe(0);

    // And the failure is durable, not a log line that scrolls away.
    const deadLettered = queues.added('dead-letter');
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]!.data.sourceQueue).toBe('outbound-messages');
    expect(deadLettered[0]!.data.error).toContain('TEMPLATE_UNAVAILABLE');
  });
});
