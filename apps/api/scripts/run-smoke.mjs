import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseGateway } from './release-gateway.mjs';
import { requireLoopbackUrl, smokeConfig } from './smoke-config.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let gateway;
try {
  if (existsSync(here('../../../.env')) || existsSync(here('../.env'))) {
    throw new Error('Run the synthetic fixture from a checkout without application .env files');
  }
  const db = requireLoopbackUrl(process.env.DATABASE_URL, 'DATABASE_URL', ['postgresql:', 'postgres:']);
  const direct = requireLoopbackUrl(process.env.DIRECT_URL, 'DIRECT_URL', ['postgresql:', 'postgres:']);
  const redis = requireLoopbackUrl(process.env.REDIS_URL, 'REDIS_URL', ['redis:']);
  if (!db.pathname.startsWith('/flowdesk_g1_') || db.host !== direct.host || db.pathname !== direct.pathname ||
      !redis.port || redis.port === '6379') {
    throw new Error('Use a disposable flowdesk_g1_* PostgreSQL database and a dedicated Redis port');
  }
  const childEnv = {
    NODE_ENV: 'development', LOG_LEVEL: 'warn', HAIKU_FALLBACK_ENABLED: 'false',
    JWT_SECRET: 'flowdesk-smoke-synthetic-access-key-000', JWT_REFRESH_SECRET: 'flowdesk-smoke-synthetic-refresh-key-000',
    ENCRYPTION_KEY: '0'.repeat(64), META_WEBHOOK_SECRET: 'flowdesk-smoke-synthetic-webhook-key-000',
    FRONTEND_URL: 'http://127.0.0.1:5173',
    DATABASE_URL: db.href, DIRECT_URL: direct.href, REDIS_URL: redis.href,
  };
  for (const key of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const port = process.env.SMOKE_PORT ?? '3017';
  childEnv.PORT = port;
  childEnv.API_URL = `http://127.0.0.1:${port}`;
  const { apiOrigin } = smokeConfig(childEnv);
  child = spawn(process.execPath, ['--import', new URL('smoke-provider.mjs', import.meta.url).href, here('../dist/server.js')], {
    env: childEnv, stdio: 'inherit', windowsHide: true, cwd: here('..'),
  });
  const stopped = once(child, 'exit');
  const deadline = Date.now() + 45_000;
  let healthy = false;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(1_000), redirect: 'error' });
      if (response.ok && (await response.json()).status === 'ok') {
        healthy = true;
        break;
      }
    } catch {
      // Startup may still be waiting for dependencies.
    }
    await wait(300);
  }
  if (!healthy) throw new Error('Synthetic API did not reach healthy state');
  gateway = releaseGateway(new URL(apiOrigin), here('../../web/dist'));
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`;
  const [deepLink, unknownApi] = await Promise.all(['/orders/example', '/api/v1/fixture-unknown'].map((path) =>
    fetch(gatewayOrigin + path, { signal: AbortSignal.timeout(5_000), redirect: 'error' })));
  if (!deepLink.ok || !deepLink.headers.get('content-type')?.startsWith('text/html') || !(await deepLink.text()).includes('<div id="root">')) {
    throw new Error('The release gateway did not serve the compiled SPA on a deep link');
  }
  if (unknownApi.status !== 404 || !unknownApi.headers.get('content-type')?.startsWith('application/json')) {
    throw new Error('The release gateway did not preserve the API JSON 404');
  }
  await unknownApi.json();
  console.log('Release gateway serves the compiled SPA deep link and preserves API JSON 404');
  const runner = spawn(process.execPath, [here('smoke-test.mjs')], {
    env: { ...childEnv, API_URL: gatewayOrigin }, stdio: 'inherit', windowsHide: true,
  });
  const [code] = await once(runner, 'exit');
  process.exitCode = code ?? 1;
  child.kill('SIGTERM');
  await stopped;
} catch (error) {
  console.error(`Smoke fixture failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  gateway?.closeAllConnections();
  gateway?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
