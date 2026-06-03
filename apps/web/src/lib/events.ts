type EventCallback = (event: { type: string; payload: unknown }) => void;

const listeners = new Set<EventCallback>();

export const sseEventBus = {
  emit(type: string, payload: unknown): void {
    listeners.forEach((cb) => cb({ type, payload }));
  },
  subscribe(callback: EventCallback): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
