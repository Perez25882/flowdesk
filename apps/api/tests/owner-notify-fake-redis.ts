/**
 * A minimal in-memory stand-in for the commands `owner-notifications.ts` uses
 * against Redis: `SET NX EX` to claim a cooldown slot, and the two small
 * transactions that maintain the coalescing counter.
 *
 * TTLs are not simulated. The cooldown expiring is instead modelled by
 * `expireCooldown()`, which is the only time transition the tests care about
 * and avoids making them depend on timers.
 */
export class FakeRedis {
  readonly store = new Map<string, string>();

  /** When set, every command rejects — used to prove the Redis-down path. */
  failing = false;

  async set(
    key: string,
    value: string,
    _ex: 'EX',
    _seconds: number,
    mode: 'NX',
  ): Promise<'OK' | null> {
    this.assertUp();
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  multi(): FakeMulti {
    this.assertUp();
    return new FakeMulti(this);
  }

  /** Drops every cooldown claim, as their TTLs would. */
  expireCooldowns(): void {
    for (const key of [...this.store.keys()]) {
      if (key.includes(':cooldown:')) this.store.delete(key);
    }
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
