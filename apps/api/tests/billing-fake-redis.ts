/**
 * In-memory stand-in for the Redis commands the billing code uses: `GET`,
 * `SET` with and without `NX`, `DEL`, and the atomic `GETDEL` that claims a
 * pending checkout.
 *
 * TTLs are not simulated. Nothing in billing depends on a key expiring — the
 * schedule TTL is deliberately far longer than any date it describes — so
 * modelling expiry would only add a timer the tests would have to wait on.
 */
export class BillingFakeRedis {
  readonly store = new Map<string, string>();

  /** When set, every command rejects — used to prove the Redis-down paths. */
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

  async getdel(key: string): Promise<string | null> {
    this.assertUp();
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }

  /** Reads a JSON value straight out of the store, for assertions. */
  json<T>(key: string): T | null {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private assertUp(): void {
    if (this.failing) throw new Error('Redis unavailable');
  }
}
