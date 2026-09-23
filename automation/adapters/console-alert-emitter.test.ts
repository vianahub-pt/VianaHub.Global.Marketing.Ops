import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createAlertEmitter } from "../domain/alert-emitter.js";
import type { AlertEntry } from "../domain/alert-schema.js";
import { createAlertEntry } from "../domain/alert-schema.js";
import { createConsoleAlertEmitter } from "./console-alert-emitter.js";

// --- Helpers ---

function createTestAlert(overrides?: Partial<AlertEntry>): AlertEntry {
  return createAlertEntry({
    severity: "info",
    category: "system",
    message: "Test alert",
    correlationIds: { runId: "run-123" },
    clock: { now: () => new Date("2026-01-15T10:30:00.000Z") },
    ...overrides,
  });
}

// --- Tests ---

describe("createConsoleAlertEmitter", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("info/warn writes to stdout", () => {
    const emitter = createAlertEmitter();
    createConsoleAlertEmitter(emitter);

    const infoAlert = createTestAlert({ severity: "info" });
    emitter.emit(infoAlert);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    const output = stdoutSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[ALERT][INFO]");

    // Reset for warn
    stdoutSpy.mockClear();
    stderrSpy.mockClear();

    const warnAlert = createTestAlert({ severity: "warn", message: "Warning" });
    emitter.emit(warnAlert);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    const warnOutput = stdoutSpy.mock.calls[0]![0] as string;
    expect(warnOutput).toContain("[ALERT][WARN]");
  });

  it("error/critical writes to stderr", () => {
    const emitter = createAlertEmitter();
    createConsoleAlertEmitter(emitter);

    const errorAlert = createTestAlert({ severity: "error", message: "Error occurred" });
    emitter.emit(errorAlert);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(0);

    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[ALERT][ERROR]");

    // Reset for critical
    stdoutSpy.mockClear();
    stderrSpy.mockClear();

    const criticalAlert = createTestAlert({ severity: "critical", message: "Critical failure" });
    emitter.emit(criticalAlert);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(0);

    const criticalOutput = stderrSpy.mock.calls[0]![0] as string;
    expect(criticalOutput).toContain("[ALERT][CRITICAL]");
  });

  it("output is structured JSON", () => {
    const emitter = createAlertEmitter();
    createConsoleAlertEmitter(emitter);

    const alert = createTestAlert();
    emitter.emit(alert);

    const output = stdoutSpy.mock.calls[0]![0] as string;
    // Extract JSON part after [ALERT][INFO]
    const jsonStr = output.replace("[ALERT][INFO] ", "").trim();
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    expect(parsed["alertId"]).toBe(alert.alertId);
    expect(parsed["severity"]).toBe("info");
    expect(parsed["category"]).toBe("system");
    expect(parsed["message"]).toBe("Test alert");
    expect(parsed["correlationIds"]).toEqual({ runId: "run-123" });
    expect(parsed["timestamp"]).toBe("2026-01-15T10:30:00.000Z");
  });

  it("metadata is redacted before printing", () => {
    const emitter = createAlertEmitter();
    createConsoleAlertEmitter(emitter);

    const alert = createTestAlert({
      metadata: {
        token: "secret=mysecrettoken123",
        safe: "normal-value",
      },
    });
    emitter.emit(alert);

    const output = stdoutSpy.mock.calls[0]![0] as string;
    const jsonStr = output.replace("[ALERT][INFO] ", "").trim();
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const metadata = parsed["metadata"] as Record<string, unknown>;
    expect(metadata["safe"]).toBe("normal-value");
    expect(metadata["token"]).toContain("[REDACTED]");
  });

  it("does not mutate the original emitter", () => {
    const emitter = createAlertEmitter();
    const handler = vi.fn();
    emitter.subscribe(handler);

    const wrapped = createConsoleAlertEmitter(emitter);

    // The wrapped emitter should be the same instance
    expect(wrapped).toBe(emitter);

    // The original handler should still be called
    const alert = createTestAlert();
    emitter.emit(alert);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(alert);
  });
});
