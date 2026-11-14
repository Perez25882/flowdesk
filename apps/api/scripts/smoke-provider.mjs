import { Socket } from 'node:net';

process.on('message', (message) => {
  if (message === 'synthetic-smoke-shutdown') process.emit('SIGTERM', 'SIGTERM');
});

const loopback = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !loopback.has(host)) throw new Error('Synthetic smoke blocked a non-loopback socket');
  return connect.apply(this, args);
};

const fetchNormally = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://graph.facebook.com' &&
      /^\/v\d+\.\d+\/smoke-(?:b-)?[a-f0-9]{8}\/messages$/.test(url.pathname) && init?.method === 'POST') {
    return Response.json({ error: { code: 190, message: 'Synthetic revoked token' } }, { status: 401 });
  }
  if (!loopback.has(url.hostname)) throw new Error('Synthetic smoke blocked a non-loopback fetch');
  return fetchNormally(input, { ...init, redirect: init?.redirect === 'manual' ? 'manual' : 'error' });
};
