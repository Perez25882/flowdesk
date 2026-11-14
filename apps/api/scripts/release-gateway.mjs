import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLoopbackUrl } from './smoke-config.mjs';

const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };

export function releaseGateway(api, assets) {
  const root = resolve(assets);
  return createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      if (url.pathname === '/health' || url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
        const upstream = request(new URL(url.pathname + url.search, api), {
          method: incoming.method, headers: { ...incoming.headers, host: api.host },
        }, (reply) => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
          response.on('close', () => reply.destroy());
        });
        upstream.on('error', () => {
          if (response.headersSent) return response.destroy();
          response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"code":"API_UNAVAILABLE"}');
        });
        incoming.on('aborted', () => upstream.destroy());
        incoming.pipe(upstream);
        return;
      }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') return response.writeHead(405).end();
      const path = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (path !== root && !path.startsWith(root + sep)) return response.writeHead(404).end();
      const file = (await stat(path).catch(() => null))?.isFile()
        ? path : extname(path) || url.pathname.startsWith('/assets/') ? null : resolve(root, 'index.html');
      if (!file || !(await stat(file).catch(() => null))?.isFile()) return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff' });
      if (incoming.method === 'HEAD') return response.end();
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      if (response.headersSent) return response.destroy();
      response.writeHead(400).end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const api = requireLoopbackUrl(process.env.API_URL ?? 'http://127.0.0.1:3000', 'API_URL', ['http:']);
  const assets = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const server = releaseGateway(api, assets);
  server.listen(Number(process.env.RELEASE_PORT ?? 4173), '127.0.0.1');
}
