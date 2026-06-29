import { useEffect, useState } from 'react';
import { sseEventBus } from '@/lib/events';

const API_BASE = '/api/v1';
const SSE_URL = `${API_BASE}/sse/connect`;

let globalEventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

const handlers = new Map<string, Set<(data: unknown) => void>>();

function dispatchEvent(eventType: string, data: unknown): void {
  const typeHandlers = handlers.get(eventType);
  if (typeHandlers) {
    typeHandlers.forEach((handler) => {
      try {
        handler(data);
      } catch (error: unknown) {
        // eslint-disable-next-line no-console
        // Intentionally swallowing handler errors to prevent crashing the event loop
      }
    });
  }
}

function getAccessToken(): string | null {
  return localStorage.getItem('accessToken');
}

function connect(): EventSource | null {
  const token = getAccessToken();
  if (!token) return null;

  const url = `${SSE_URL}?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);

  es.onopen = () => {
    reconnectDelay = 1000;
    sseEventBus.emit('sse.connected', null);
  };

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      sseEventBus.emit(event.type, data);
      dispatchEvent(event.type, data);
    } catch {
      dispatchEvent(event.type, event.data);
    }
  };

  es.onerror = () => {
    es.close();
    globalEventSource = null;
    sseEventBus.emit('sse.disconnected', null);
    scheduleReconnect();
  };

  return es;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    globalEventSource = connect();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalEventSource) {
    globalEventSource.close();
    globalEventSource = null;
  }
}

export function subscribe(eventType: string, handler: (data: unknown) => void): () => void {
  if (!handlers.has(eventType)) {
    handlers.set(eventType, new Set());
  }
  handlers.get(eventType)?.add(handler);

  return () => {
    handlers.get(eventType)?.delete(handler);
  };
}

export function unsubscribe(eventType: string, handler: (data: unknown) => void): void {
  handlers.get(eventType)?.delete(handler);
}

export interface SSEHookResult {
  connected: boolean;
  subscribe: (eventType: string, handler: (data: unknown) => void) => () => void;
  unsubscribe: (eventType: string, handler: (data: unknown) => void) => void;
}

export function useSSE(): SSEHookResult {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!globalEventSource) {
      globalEventSource = connect();
    }

    const unsubConnect = sseEventBus.subscribe((event) => {
      if (event.type === 'sse.connected') setConnected(true);
      if (event.type === 'sse.disconnected') setConnected(false);
    });

    window.addEventListener('online', () => {
      if (!globalEventSource) {
        globalEventSource = connect();
      }
    });

    return () => {
      unsubConnect();
      // Do NOT disconnect on unmount — other components may be using SSE
    };
  }, []);

  return {
    connected,
    subscribe,
    unsubscribe,
  };
}

export { disconnect };

