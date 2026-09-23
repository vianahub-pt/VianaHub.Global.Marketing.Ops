/**
 * Console alert emitter (MVP).
 *
 * Outputs structured alert logs to stdout/stderr based on severity.
 * - info/warn → stdout
 * - error/critical → stderr
 *
 * No external SaaS dependency.
 */

import type { AlertEmitter, AlertHandler } from "../domain/alert-emitter.js";
import type { AlertEntry } from "../domain/alert-schema.js";
import { redactLog } from "../domain/redaction.js";

/**
 * Creates a console-based AlertEmitter.
 *
 * Wraps an existing AlertEmitter and subscribes a console handler.
 * Returns the wrapped emitter.
 */
export function createConsoleAlertEmitter(inner: AlertEmitter): AlertEmitter {
  const consoleHandler: AlertHandler = (alert: AlertEntry) => {
    const redacted = alert.metadata ? redactLog(alert.metadata) : undefined;
    const logEntry = {
      alertId: alert.alertId,
      timestamp: alert.timestamp.toISOString(),
      severity: alert.severity,
      category: alert.category,
      message: alert.message,
      correlationIds: alert.correlationIds,
      ...(alert.deduplicationKey ? { deduplicationKey: alert.deduplicationKey } : {}),
      ...(alert.suppressedCount !== undefined ? { suppressedCount: alert.suppressedCount } : {}),
      ...(redacted ? { metadata: redacted } : {}),
    };

    const formatted = JSON.stringify(logEntry);

    if (alert.severity === "error" || alert.severity === "critical") {
      process.stderr.write(`[ALERT][${alert.severity.toUpperCase()}] ${formatted}\n`);
    } else {
      process.stdout.write(`[ALERT][${alert.severity.toUpperCase()}] ${formatted}\n`);
    }
  };

  inner.subscribe(consoleHandler);
  return inner;
}
