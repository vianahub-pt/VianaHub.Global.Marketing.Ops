/**
 * Alert emitter interface with deduplication.
 *
 * Decoupled from implementation — can be console, file, or external SaaS.
 * Supports deduplication via deduplicationKey within a configurable window.
 */

import type { AlertEntry, AlertId } from "./alert-schema.js";
import type { Clock } from "./clock.js";

// --- Types ---

export type AlertHandler = (alert: AlertEntry) => void;

export interface AlertEmitterConfig {
  /** Deduplication window in milliseconds. Default: 5 min (300000ms) */
  readonly deduplicationWindowMs?: number;
}

/**
 * Interface for emitting and subscribing to alerts.
 */
export interface AlertEmitter {
  /** Emit an alert. Returns the alert (possibly with suppressedCount). */
  emit(alert: AlertEntry): AlertEntry;

  /** Subscribe to alerts. Returns an unsubscribe function. */
  subscribe(handler: AlertHandler): () => void;
}

// --- Deduplication State (internal) ---

interface DeduplicationRecord {
  readonly firstSeen: Date;
  readonly alertId: AlertId;
  suppressedCount: number;
}

// --- Factory ---

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates an in-memory alert emitter with deduplication.
 *
 * AC-29: Alerts with same deduplicationKey within the configured window
 * are suppressed. The second emit records suppressedCount on the original.
 *
 * - Events are dispatched synchronously to subscribers in registration order.
 * - Subscriber errors are caught and logged to stderr (never propagated).
 * - Deduplication is per deduplicationKey within a sliding window.
 */
export function createAlertEmitter(config?: AlertEmitterConfig, clock?: Clock): AlertEmitter {
  const handlers = new Set<AlertHandler>();
  const deduplicationWindowMs = config?.deduplicationWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const deduplicationMap = new Map<string, DeduplicationRecord>();

  function pruneExpired(now: Date): void {
    const cutoff = now.getTime() - deduplicationWindowMs;
    for (const [key, record] of deduplicationMap) {
      if (record.firstSeen.getTime() < cutoff) {
        deduplicationMap.delete(key);
      }
    }
  }

  function isDuplicate(key: string, now: Date): DeduplicationRecord | null {
    const record = deduplicationMap.get(key);
    if (!record) {
      return null;
    }
    const age = now.getTime() - record.firstSeen.getTime();
    if (age > deduplicationWindowMs) {
      // Expired — remove and allow re-emission
      deduplicationMap.delete(key);
      return null;
    }
    return record;
  }

  return {
    emit(alert: AlertEntry): AlertEntry {
      const now = clock?.now() ?? new Date();
      pruneExpired(now);

      // Deduplication check (AC-29)
      if (alert.deduplicationKey) {
        const existing = isDuplicate(alert.deduplicationKey, now);
        if (existing) {
          existing.suppressedCount++;
          // Return the original alert with updated suppressedCount
          const suppressed: AlertEntry = {
            ...alert,
            alertId: existing.alertId,
            timestamp: existing.firstSeen,
            suppressedCount: existing.suppressedCount,
          };
          return suppressed;
        }
        // Record new deduplication key (or refresh expired)
        deduplicationMap.set(alert.deduplicationKey, {
          firstSeen: alert.timestamp,
          alertId: alert.alertId,
          suppressedCount: 0,
        });
      }

      // Dispatch to subscribers
      for (const handler of handlers) {
        try {
          handler(alert);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[alert-emitter] Handler error: ${message}\n`);
        }
      }

      return alert;
    },

    subscribe(handler: AlertHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
