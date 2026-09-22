import { useEffect, useState } from 'react';
import { SSE_CONNECTED_EVENT, SSE_EVENT_TYPES } from '@flowdesk/shared';
import { sseEventBus } from '@/lib/events';
import { apiFetch } from '@/lib/api';

/**
 * The dashboard's single realtime connection.
 *
 * One `EventSource` is shared by every component that calls `useSSE`, held at
 * module scope rather than per-component, so mounting the sidebar and the
 * header does not open two streams against the same business.
 *
 * Events arrive as *named* SSE frames (`event: order.created`). `onmessage`
 * only ever fires for frames with no `event:` field, so each type has to be
 * registered explicitly, an earlier version listened on `onmessage` alone and
 * therefore received nothing at all while still reporting itself connected,
 * because `onopen` fires either way.
 */

const API_BASE = '/api/v1';
const SSE_URL = `${API_BASE}/sse/connect`;

let globalEventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
/** Guards against two callers opening a stream while a ticket request is in flight. */
let connecting = false;
/**
 * Bumped by every `disconnect()`. A ticket request that started before a
 * sign-out compares the generation it captured against this on completion and
 * discards its stream if they differ, otherwise the socket it opens would
 * belong to the account that just signed out.
 */
let generation = 0;
const MAX_RECONNECT_DELAY = 30_000;

interface TicketResponse {
  ticket: string;
  expiresIn: number;
}

/**
 * Exchanges the bearer token for a single-use stream ticket.
 *
 * `EventSource` cannot send an Authorization header, and putting the access
 * token in the query string would leak it into proxy logs and browser history.
 * The ticket is worth one stream for thirty seconds instead.
 */
async function requestTicket(): Promise<string | null> {
  try {
    const response = await apiFetch<TicketResponse>('/sse/ticket', { method: 'POST' });
    return response.ticket;
  } catch {
    // Not signed in yet, or the token expired, the reconnect loop retries.
    return null;
  }
}

function attachHandlers(es: EventSource): void {
  es.addEventListener(SSE_CONNECTED_EVENT, () => {
    reconnectDelay = 1000;
    sseEventBus.emit('sse.connected', null);
  });

  for (const eventType of SSE_EVENT_TYPES) {
    es.addEventListener(eventType, (event: MessageEvent<string>) => {
      try {
        sseEventBus.emit(eventType, JSON.parse(event.data));
      } catch {
        // A frame we cannot decode is dropped rather than tearing down the
        // stream, the next event is usually fine.
      }
    });
  }

  es.onerror = () => {
    es.close();
    if (globalEventSource === es) {
      globalEventSource = null;
    }
    sseEventBus.emit('sse.disconnected', null);
    scheduleReconnect();
  };
}

async function connect(): Promise<void> {
  if (globalEventSource || connecting) return;

  connecting = true;
  const startedAt = generation;

  try {
    const ticket = await requestTicket();

    // A disconnect() landed while the ticket request was in flight; the ticket
    // belongs to a session that no longer exists, so drop it unused.
    if (startedAt !== generation) return;

    if (!ticket) {
      scheduleReconnect();
      return;
    }

    const es = new EventSource(`${SSE_URL}?ticket=${encodeURIComponent(ticket)}`);
    attachHandlers(es);
    globalEventSource = es;
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

/**
 * Tears the stream down and stops it coming back.
 *
 * Called on sign-out. Logging out is a client-side navigation, so without this
 * the module-scope `globalEventSource` survives into the next session: the old
 * stream stays open on the previous user's credentials, and because the socket
 * is non-null the next sign-in skips reconnecting and silently receives
 * nothing. That matters here because staff share devices.
 */
export function disconnect(): void {
  generation += 1;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (globalEventSource) {
    // Drop onerror first: close() must not look like a dropped connection and
    // schedule a reconnect for the session we are ending.
    globalEventSource.onerror = null;
    globalEventSource.close();
    globalEventSource = null;
  }

  reconnectDelay = 1000;
  sseEventBus.emit('sse.disconnected', null);
}

/** Opens the stream for a freshly signed-in session. */
export function reconnect(): void {
  disconnect();
  void connect();
}

export interface SSEHookResult {
  connected: boolean;
}

export function useSSE(): SSEHookResult {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    void connect();

    const unsubConnect = sseEventBus.subscribe((event) => {
      if (event.type === 'sse.connected') setConnected(true);
      if (event.type === 'sse.disconnected') setConnected(false);
    });

    // Named so cleanup can remove it. As an inline closure this accumulated a
    // new permanent listener on every mount.
    const handleOnline = (): void => {
      if (!globalEventSource) void connect();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      unsubConnect();
      window.removeEventListener('online', handleOnline);
      // The stream itself is deliberately left open: it is shared, and another
      // mounted component may still be using it. `disconnect()` on sign-out is
      // what closes it.
    };
  }, []);

  return { connected };
}
