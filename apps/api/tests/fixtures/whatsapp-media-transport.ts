// Only these synthetic provider origins are routed to the test HTTP server.
export function localWhatsAppTransport(origin: string): () => void {
  if (new URL(origin).hostname !== '127.0.0.1')
    throw new Error('Synthetic transport requires loopback');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === 'https://graph.facebook.com') {
      return originalFetch(`${origin}/graph${url.pathname}${url.search}`, init);
    }
    if (url.origin === 'https://lookaside.fbsbx.com') {
      return originalFetch(`${origin}${url.pathname}${url.search}`, init);
    }
    if (url.origin === origin) return originalFetch(input, init);
    throw new Error('Unapproved test network destination');
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}
