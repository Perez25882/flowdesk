/**
 * Serves the production build the way a deployment would.
 *
 * The 3G measurement has to run against `dist/`. The Vite dev server ships
 * every module as a separate unbundled request, so throttling it measures the
 * dev server rather than the product — the first attempt reported two minutes
 * for a page that is a few hundred kilobytes.
 */
import http from 'node:http';
import { createGzip } from 'node:zlib';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DIST = '/home/claude/flowdesk/apps/web/dist';
const API = 'http://127.0.0.1:3001';
const PORT = Number(process.env.PORT ?? 4174);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

http.createServer((req, res) => {
  if (req.url.startsWith('/api/v1')) {
    const proxied = http.request(`${API}${req.url}`, { method: req.method, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    proxied.on('error', () => { res.statusCode = 502; res.end('{}'); });
    return req.pipe(proxied);
  }

  // Never let a request escape the build directory.
  const requested = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, requested);

  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');

  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');

  // Compress text assets. Every real host does this, and without it a
  // performance measurement is meaningless: the React chunk is 339KB on the
  // wire uncompressed and 108KB gzipped, which is the difference between
  // missing and meeting the 3G budget.
  const compressible = /\.(html|js|css|json|svg)$/.test(file);
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

  if (compressible && acceptsGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return createReadStream(file).pipe(createGzip()).pipe(res);
  }

  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`prod build on ${PORT}`));
