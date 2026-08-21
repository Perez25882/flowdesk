/**
 * The scaffolding one integration test needs to run the real pipeline in
 * process: an in-memory Prisma, an in-memory Redis, queues that hand jobs
 * straight to the real worker handlers, and a recorder for the Meta Graph API.
 *
 * None of this is a database. It matches Prisma's call shapes closely enough to
 * run the code paths under test and it records every write, which is what the
 * assertions read. It does not enforce a unique index, a foreign key, a
 * transaction boundary or an isolation level — so a defect that only shows up
 * under concurrency or a constraint violation is invisible here and needs a real
 * Postgres. `wk-pipeline.integration.test.ts` says so at the top, and says it
 * again next to each thing it cannot check.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

/** Foreign keys the fake resolves when a `select` or `include` names them. */
const RELATIONS: Record<string, Record<string, { model: string; foreignKey: string }>> = {
  message: { customer: { model: 'customer', foreignKey: 'customerId' } },
  order: {
    business: { model: 'business', foreignKey: 'businessId' },
    customer: { model: 'customer', foreignKey: 'customerId' },
    assignedTo: { model: 'staff', foreignKey: 'assignedStaffId' },
  },
  payment: {
    business: { model: 'business', foreignKey: 'businessId' },
    customer: { model: 'customer', foreignKey: 'customerId' },
    order: { model: 'order', foreignKey: 'orderId' },
  },
};

/** Column defaults the schema declares, applied on create so reads see them. */
const DEFAULTS: Record<string, Row> = {
  business: {
    active: true,
    deletedAt: null,
    plan: 'STARTER',
    trialEndsAt: null,
    suspendedAt: null,
    paystackSubCode: null,
    monthlyConvoCount: 0,
    monthlyOrderCount: 0,
    convoCountResetAt: null,
    orderCountResetAt: null,
    replyTemplates: null,
    waConnectionState: 'ACTIVE',
    waConnectionError: null,
    notifyOnNewOrder: true,
    notifyOnLowStock: true,
    notifyOnPayment: true,
    phone: null,
  },
  customer: {
    name: null,
    blacklisted: false,
    lastInboundAt: null,
    lastInteractionAt: null,
  },
  message: {
    body: null,
    customerId: null,
    intent: 'UNCLASSIFIED',
    intentConfidence: null,
    classifiedBy: null,
    processed: false,
    processedAt: null,
    processingError: null,
    requiresReview: false,
    relatedOrderId: null,
    sentFromApp: false,
    mediaUrl: null,
    mediaKey: null,
    mediaType: null,
    aiReplyText: null,
    aiReplyStatus: null,
    aiReplyGroundedOn: [],
    aiValidationFailed: [],
    inReplyToMessageId: null,
    sentByStaffId: null,
  },
  order: {
    status: 'PENDING',
    cancelReason: null,
    assignedStaffId: null,
    deletedAt: null,
    amountPaid: 0,
    isManual: false,
  },
  product: { active: true, deletedAt: null, aliases: [] },
};

const OPERATORS = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'increment',
  'decrement',
  'set',
]);

function isOperatorObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => OPERATORS.has(key))
  );
}

function ordinal(value: unknown): any {
  return value instanceof Date ? value.getTime() : value;
}

function matchesCondition(actual: unknown, condition: unknown): boolean {
  if (condition === null || condition === undefined) {
    return actual === null || actual === undefined;
  }

  if (condition instanceof Date) {
    return actual instanceof Date && actual.getTime() === condition.getTime();
  }

  if (isOperatorObject(condition)) {
    const test = condition as Row;
    if ('equals' in test && !matchesCondition(actual, test.equals)) return false;
    if ('not' in test && matchesCondition(actual, test.not)) return false;
    if ('in' in test && !(test.in as unknown[]).some((value) => matchesCondition(actual, value))) {
      return false;
    }
    if ('notIn' in test && (test.notIn as unknown[]).some((v) => matchesCondition(actual, v))) {
      return false;
    }
    if ('gt' in test && !(ordinal(actual) > ordinal(test.gt))) return false;
    if ('gte' in test && !(ordinal(actual) >= ordinal(test.gte))) return false;
    if ('lt' in test && !(ordinal(actual) < ordinal(test.lt))) return false;
    if ('lte' in test && !(ordinal(actual) <= ordinal(test.lte))) return false;
    if ('contains' in test && !String(actual ?? '').includes(String(test.contains))) return false;
    return true;
  }

  return actual === condition;
}

function toArray(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [value as Row];
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;

  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;

    if (key === 'NOT') {
      if (toArray(condition).some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }

    if (key === 'AND') {
      if (!toArray(condition).every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }

    if (key === 'OR') {
      if (!toArray(condition).some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }

    // A compound unique — `{ businessId_waNumber: { businessId, waNumber } }` —
    // names no column of its own, so it is expanded into its parts.
    const isCompoundKey =
      !(key in row) &&
      typeof condition === 'object' &&
      condition !== null &&
      !(condition instanceof Date) &&
      !isOperatorObject(condition);

    if (isCompoundKey) {
      if (!matchesWhere(row, condition as Row)) return false;
      continue;
    }

    if (!matchesCondition(row[key], condition)) return false;
  }

  return true;
}

function applyData(row: Row, data: Row): Row {
  const next = { ...row };

  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      !Array.isArray(value)
    ) {
      const operation = value as Row;
      if ('increment' in operation) {
        next[key] = Number(next[key] ?? 0) + Number(operation.increment);
        continue;
      }
      if ('decrement' in operation) {
        next[key] = Number(next[key] ?? 0) - Number(operation.decrement);
        continue;
      }
      if ('set' in operation) {
        next[key] = operation.set;
        continue;
      }
    }

    next[key] = value;
  }

  return next;
}

export interface RecordedWrite {
  model: string;
  operation: string;
  data: Row;
}

export class FakeDatabase {
  readonly tables = new Map<string, Row[]>();
  readonly writes: RecordedWrite[] = [];

  /** Set to make the next matching write throw, to model a mid-job failure. */
  private failures: Array<{ model: string; operation: string; match?: (data: Row) => boolean }> = [];

  private sequence = 0;
  private readonly delegates = new Map<string, Row>();

  readonly client: any = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string' || property.startsWith('$') || property === 'then') {
          return undefined;
        }
        return this.delegate(property);
      },
    },
  );

  table(model: string): Row[] {
    let rows = this.tables.get(model);
    if (!rows) {
      rows = [];
      this.tables.set(model, rows);
    }
    return rows;
  }

  seed(model: string, row: Row): Row {
    const stored = { ...DEFAULTS[model], createdAt: new Date(), ...row };
    stored.id ??= `${model}_${++this.sequence}`;
    this.table(model).push(stored);
    return stored;
  }

  /** Makes the next write matching this description throw once. */
  failNextWrite(model: string, operation: string, match?: (data: Row) => boolean): void {
    this.failures.push({ model, operation, ...(match ? { match } : {}) });
  }

  reset(): void {
    this.tables.clear();
    this.writes.length = 0;
    this.failures = [];
    this.sequence = 0;
    this.delegates.clear();
  }

  private record(model: string, operation: string, data: Row): void {
    const index = this.failures.findIndex(
      (failure) =>
        failure.model === model &&
        failure.operation === operation &&
        (failure.match ? failure.match(data) : true),
    );

    if (index >= 0) {
      this.failures.splice(index, 1);
      throw new Error(`Injected database failure on ${model}.${operation}`);
    }

    this.writes.push({ model, operation, data });
  }

  private project(model: string, row: Row, args: Row | undefined): Row {
    const shaped: Row = { ...row };
    const spec = { ...(args?.select ?? {}), ...(args?.include ?? {}) };

    for (const [key, value] of Object.entries(spec)) {
      const relation = RELATIONS[model]?.[key];
      if (!relation || !value) continue;

      const foreignKey = row[relation.foreignKey];
      const related = foreignKey
        ? this.table(relation.model).find((candidate) => candidate.id === foreignKey)
        : undefined;

      shaped[key] = related ? { ...related } : null;
    }

    return shaped;
  }

  private sorted(model: string, rows: Row[], orderBy: Row | undefined): Row[] {
    if (!orderBy) return rows;

    const [field, direction] = Object.entries(orderBy)[0] ?? [];
    if (!field) return rows;

    return [...rows].sort((a, b) => {
      const left = ordinal(a[field]);
      const right = ordinal(b[field]);
      if (left === right) return 0;
      const ascending = left < right ? -1 : 1;
      return direction === 'desc' ? -ascending : ascending;
    });
  }

  private delegate(model: string): Row {
    const cached = this.delegates.get(model);
    if (cached) return cached;

    const rows = (): Row[] => this.table(model);

    const delegate: Row = {
      findUnique: async (args: Row) => {
        const found = rows().find((row) => matchesWhere(row, args.where));
        return found ? this.project(model, found, args) : null;
      },
      findFirst: async (args: Row = {}) => {
        const matching = this.sorted(
          model,
          rows().filter((row) => matchesWhere(row, args.where)),
          args.orderBy,
        );
        const found = matching[0];
        return found ? this.project(model, found, args) : null;
      },
      findMany: async (args: Row = {}) => {
        let matching = this.sorted(
          model,
          rows().filter((row) => matchesWhere(row, args.where)),
          args.orderBy,
        );
        if (typeof args.skip === 'number') matching = matching.slice(args.skip);
        if (typeof args.take === 'number') matching = matching.slice(0, args.take);
        return matching.map((row) => this.project(model, row, args));
      },
      count: async (args: Row = {}) => rows().filter((row) => matchesWhere(row, args.where)).length,
      create: async (args: Row) => {
        this.record(model, 'create', args.data);
        const stored = { ...DEFAULTS[model], createdAt: new Date(), ...args.data };
        stored.id ??= `${model}_${++this.sequence}`;
        rows().push(stored);
        return this.project(model, stored, args);
      },
      update: async (args: Row) => {
        this.record(model, 'update', args.data);
        const index = rows().findIndex((row) => matchesWhere(row, args.where));
        if (index < 0) throw new Error(`No ${model} matches ${JSON.stringify(args.where)}`);
        const updated = applyData(rows()[index]!, args.data);
        rows()[index] = updated;
        return this.project(model, updated, args);
      },
      updateMany: async (args: Row) => {
        this.record(model, 'updateMany', args.data);
        let count = 0;
        const all = rows();
        for (let index = 0; index < all.length; index += 1) {
          if (!matchesWhere(all[index]!, args.where)) continue;
          all[index] = applyData(all[index]!, args.data);
          count += 1;
        }
        return { count };
      },
      upsert: async (args: Row) => {
        const index = rows().findIndex((row) => matchesWhere(row, args.where));

        if (index >= 0) {
          this.record(model, 'upsert:update', args.update);
          const updated = applyData(rows()[index]!, args.update);
          rows()[index] = updated;
          return this.project(model, updated, args);
        }

        this.record(model, 'upsert:create', args.create);
        const stored = { ...DEFAULTS[model], createdAt: new Date(), ...args.create };
        stored.id ??= `${model}_${++this.sequence}`;
        rows().push(stored);
        return this.project(model, stored, args);
      },
    };

    this.delegates.set(model, delegate);
    return delegate;
  }
}

/**
 * The Redis commands this pipeline issues: the webhook's dedupe claim, the
 * per-tenant fairness counter, the per-number send throttle and the reply
 * de-duplication claim. TTLs are not simulated; `expire()` drops a key on
 * demand instead, which is the only time transition the tests care about.
 */
export class FakeRedis {
  readonly store = new Map<string, string>();
  failing = false;

  async get(key: string): Promise<string | null> {
    this.assertUp();
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _ex?: 'EX',
    _seconds?: number,
    mode?: 'NX',
  ): Promise<'OK' | null> {
    this.assertUp();
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.assertUp();
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    this.assertUp();
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  async decr(key: string): Promise<number> {
    this.assertUp();
    const next = Number(this.store.get(key) ?? '0') - 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    this.assertUp();
    return 1;
  }

  async getdel(key: string): Promise<string | null> {
    this.assertUp();
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }

  multi(): FakeMulti {
    this.assertUp();
    return new FakeMulti(this);
  }

  reset(): void {
    this.store.clear();
    this.failing = false;
  }

  private assertUp(): void {
    if (this.failing) throw new Error('Redis unavailable');
  }
}

class FakeMulti {
  private readonly operations: Array<() => unknown> = [];

  constructor(private readonly redis: FakeRedis) {}

  incr(key: string): this {
    this.operations.push(() => {
      const next = Number(this.redis.store.get(key) ?? '0') + 1;
      this.redis.store.set(key, String(next));
      return next;
    });
    return this;
  }

  expire(_key: string, _seconds: number): this {
    this.operations.push(() => 1);
    return this;
  }

  get(key: string): this {
    this.operations.push(() => this.redis.store.get(key) ?? null);
    return this;
  }

  del(key: string): this {
    this.operations.push(() => (this.redis.store.delete(key) ? 1 : 0));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.operations.map((operation) => [null, operation()]);
  }
}

export interface FakeJob {
  id: string;
  name: string;
  queue: string;
  data: any;
  opts: Row;
  attemptsMade: number;
}

/**
 * Queues that run in this process.
 *
 * A job added to a queue is handed to whatever `Worker` was constructed for the
 * same name, which is how the real workers end up wired to each other exactly as
 * they are in production — the message processor's `add` is what starts the
 * intent classifier, and the notification layer's `add` is what starts the
 * outbound worker.
 *
 * Job ids behave as BullMQ's do for the property under test: a second job
 * carrying an id the queue has already seen is refused. Unlike BullMQ the
 * memory never expires, which is the optimistic reading — the real thing forgets
 * after `removeOnComplete` jobs, which is precisely why defect 3's suppression
 * was both silent and arbitrary.
 */
export class QueueHarness {
  readonly pending: FakeJob[] = [];
  readonly handlers = new Map<string, (job: FakeJob) => Promise<unknown>>();
  readonly listeners = new Map<string, Array<{ event: string; run: (...args: any[]) => unknown }>>();
  readonly seen = new Map<string, FakeJob>();
  readonly processed: FakeJob[] = [];
  readonly failures: Array<{ job: FakeJob; error: Error }> = [];
  readonly defaults = new Map<string, Row>();

  private sequence = 0;

  reset(): void {
    this.pending.length = 0;
    this.handlers.clear();
    this.listeners.clear();
    this.seen.clear();
    this.processed.length = 0;
    this.failures.length = 0;
    this.defaults.clear();
    this.sequence = 0;
  }

  /** Jobs added to one queue, in order. */
  added(queue: string): FakeJob[] {
    return [...this.seen.values()].filter((job) => job.queue === queue);
  }

  registerQueue(name: string, options: Row | undefined): void {
    this.defaults.set(name, options?.defaultJobOptions ?? {});
  }

  add(queue: string, name: string, data: unknown, options: Row | undefined): FakeJob {
    const explicitId = options?.jobId as string | undefined;

    if (explicitId) {
      const existing = this.seen.get(`${queue}:${explicitId}`);
      if (existing) return existing;
    }

    const id = explicitId ?? `${queue}-${++this.sequence}`;

    const job: FakeJob = {
      id,
      name,
      queue,
      data,
      opts: { ...(this.defaults.get(queue) ?? {}), ...(options ?? {}) },
      attemptsMade: 0,
    };

    this.seen.set(`${queue}:${id}`, job);
    this.pending.push(job);
    return job;
  }

  getJob(queue: string, id: string): FakeJob | undefined {
    return this.seen.get(`${queue}:${id}`);
  }

  registerWorker(name: string, handler: (job: FakeJob) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }

  on(queue: string, event: string, run: (...args: any[]) => unknown): void {
    const existing = this.listeners.get(queue) ?? [];
    existing.push({ event, run });
    this.listeners.set(queue, existing);
  }

  /** Runs one job through its worker, including the worker's own event handlers. */
  async run(job: FakeJob): Promise<void> {
    const handler = this.handlers.get(job.queue);
    if (!handler) return;

    job.attemptsMade += 1;

    try {
      await handler(job);
      this.processed.push(job);
      await this.emit(job.queue, 'completed', job);
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failures.push({ job, error: failure });
      await this.emit(job.queue, 'failed', job, failure);
    }
  }

  /** Runs every queued job, and anything those jobs queue in turn. */
  async drain(): Promise<void> {
    let guard = 0;

    while (this.pending.length > 0) {
      if ((guard += 1) > 200) throw new Error('Queue harness did not settle');
      const job = this.pending.shift()!;
      await this.run(job);
    }
  }

  private async emit(queue: string, event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners.get(queue) ?? []) {
      if (listener.event !== event) continue;
      await listener.run(...args);
    }
  }
}

/** Records what the WhatsApp client actually put on the wire. */
export class MetaRecorder {
  readonly calls: Array<{ url: string; token: string; body: any }> = [];

  /** Queued responses; anything beyond them succeeds with a fresh message id. */
  private responses: Array<{ status: number; body: string }> = [];
  private sequence = 0;

  reset(): void {
    this.calls.length = 0;
    this.responses = [];
    this.sequence = 0;
  }

  /** Makes the next send fail with this Meta error code. */
  failNextWith(code: number, message: string): void {
    this.responses.push({
      status: 400,
      body: JSON.stringify({ error: { code, message } }),
    });
  }

  readonly fetch = async (url: string, init: Row): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    const authorization = String((init.headers as Row).Authorization ?? '');

    this.calls.push({ url: String(url), token: authorization.replace('Bearer ', ''), body });

    const queued = this.responses.shift();

    if (queued) {
      return new Response(queued.body, { status: queued.status });
    }

    this.sequence += 1;
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.sent-${this.sequence}` }] }),
      { status: 200 },
    );
  };
}

export const db = new FakeDatabase();
export const redis = new FakeRedis();
export const queues = new QueueHarness();
export const meta = new MetaRecorder();

/** SSE events the pipeline broadcast, recorded through the real `sse.events`. */
export const broadcasts: Array<{ businessId: string; type: string; payload: Row }> = [];

export const SSEManager = {
  getInstance: () => ({
    broadcast(businessId: string, event: { type: string; payload: Row }): void {
      broadcasts.push({ businessId, type: event.type, payload: event.payload });
    },
  }),
};

/** Stands in for BullMQ's `Queue`, bound to the in-process harness. */
export class FakeQueue {
  constructor(
    private readonly queueName: string,
    options?: Row,
  ) {
    queues.registerQueue(queueName, options);
  }

  async add(name: string, data: unknown, options?: Row): Promise<FakeJob> {
    return queues.add(this.queueName, name, data, options);
  }

  async getJob(id: string): Promise<FakeJob | undefined> {
    return queues.getJob(this.queueName, id);
  }
}

/** Stands in for BullMQ's `Worker`, registering the real handler with the harness. */
export class FakeWorker {
  constructor(
    private readonly queueName: string,
    handler: (job: FakeJob) => Promise<unknown>,
    _options?: Row,
  ) {
    queues.registerWorker(queueName, handler);
  }

  on(event: string, run: (...args: any[]) => unknown): this {
    queues.on(this.queueName, event, run);
    return this;
  }
}

/** BullMQ's own marker for "do not retry this", which the outbound worker tests for. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

export function resetHarness(): void {
  db.reset();
  redis.reset();
  meta.reset();
  broadcasts.length = 0;
  queues.pending.length = 0;
  queues.seen.clear();
  queues.processed.length = 0;
  queues.failures.length = 0;
}
