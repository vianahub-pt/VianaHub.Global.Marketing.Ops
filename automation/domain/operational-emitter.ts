/**
 * Operational event emitter interface.
 *
 * Decoupled from implementation — can be in-memory, buffered, etc.
 * Events are dispatched synchronously to all subscribers.
 */

import type { OperationalEvent } from "./operational-event.js";

// --- Types ---

export type EventHandler = (event: OperationalEvent) => void;

/**
 * Interface for emitting and subscribing to operational events.
 */
export interface OperationalEmitter {
  /** Emit an event to all subscribers. */
  emit(event: OperationalEvent): void;

  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void;
}

// --- Factory ---

/**
 * Creates an in-memory operational emitter.
 *
 * - Events are dispatched synchronously to subscribers in registration order.
 * - Subscriber errors are caught and logged to stderr (never propagated).
 * - Thread-safe: no async gaps between emit and dispatch.
 */
export function createOperationalEmitter(): OperationalEmitter {
  const handlers = new Set<EventHandler>();

  return {
    emit(event: OperationalEvent): void {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err: unknown) {
          // Subscriber errors must never break the emitter
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[operational-emitter] Handler error: ${message}\n`);
        }
      }
    },

    subscribe(handler: EventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
