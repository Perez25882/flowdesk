import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';

export async function volatileRedis(binary: string) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const scratch = await mkdtemp(join(tmpdir(), 'flowdesk-redis-restart-'));
  const config = join(scratch, 'redis.conf');
  await writeFile(config, [
    'bind 127.0.0.1', `port ${port}`, 'protected-mode yes', 'save ""', 'appendonly no',
  ].join('\n') + '\n');
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  async function stop() {
    if (!child) return;
    child.kill('SIGKILL');
    await exited;
    child = undefined;
  }
  return {
    async start(): Promise<Redis> {
      if (child) throw new Error('The disposable Redis process is already running');
      child = spawn(binary, [config], { cwd: scratch, windowsHide: true, stdio: 'ignore' });
      const failed = once(child, 'error').then(([error]) => { throw error; });
      exited = Promise.race([once(child, 'exit'), failed]).catch(() => undefined);
      const deadline = Date.now() + 15_000;
      do {
        if (child.exitCode !== null) break;
        const redis = new Redis({ host: '127.0.0.1', port, lazyConnect: true, connectTimeout: 500,
          commandTimeout: 500, retryStrategy: () => null });
        redis.on('error', () => {});
        try {
          await Promise.race([redis.connect(), failed]);
          return redis;
        } catch {
          redis.disconnect();
        }
        await delay(150);
      } while (Date.now() < deadline);
      await stop();
      throw new Error('Disposable Redis failed to start');
    },
    stop,
    async close() {
      await stop();
      await unlink(config);
      await rmdir(scratch);
    },
  };
}
