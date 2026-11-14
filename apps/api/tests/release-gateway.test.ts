import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { releaseGateway } from '../scripts/release-gateway.mjs';

async function start(server: Server): Promise<URL> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  return new URL(`http://127.0.0.1:${address.port}`);
}

it('routes deep links to the SPA and preserves API status and JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flowdesk-release-gateway-'));
  const index = join(directory, 'index.html');
  writeFileSync(index, '<html>synthetic release</html>');
  const api = createServer((request, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: request.url }));
  });
  const server = releaseGateway(await start(api), directory);
  const origin = await start(server);
  try {
    const deep = await fetch(new URL('/app/orders/synthetic', origin));
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('synthetic release');
    const absent = await fetch(new URL('/api/v1/not-there?synthetic=1', origin));
    expect(absent.status).toBe(404);
    expect(absent.headers.get('content-type')).toBe('application/json');
    expect(await absent.json()).toEqual({ path: '/api/v1/not-there?synthetic=1' });
    expect((await fetch(new URL('/assets/missing.js', origin))).status).toBe(404);
  } finally {
    server.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => api.close(() => done()))]);
    unlinkSync(index);
    rmdirSync(directory);
  }
});
