import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAlertEmitter } from "../domain/alert-emitter.js";
import type { AlertEntry } from "../domain/alert-schema.js";
import { createAlertEntry, alertEntrySchema } from "../domain/alert-schema.js";
import { createFileAlertEmitter, readPersistedAlerts } from "./file-alert-emitter.js";

// --- Helpers ---

let tempDir: string;

function createTestAlert(
  overrides?: Partial<AlertEntry> & { clock?: { now(): Date } },
): AlertEntry {
  return createAlertEntry({
    severity: "info",
    category: "system",
    message: "Test alert",
    correlationIds: { runId: "run-123" },
    clock: { now: () => new Date("2026-01-15T10:30:00.000Z") },
    ...overrides,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "file-alert-emitter-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// --- Tests ---

describe("createFileAlertEmitter", () => {
  it("creates one JSON file per alert", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("filename contains ISO timestamp and alertId", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const filename = files[0]!;
    expect(filename).toContain("_");
    expect(filename).toContain(alert.alertId);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  });

  it("file content is valid JSON matching alertEntrySchema", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    const filePath = join(tempDir, files[0]!);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Reconstitute Date for validation
    parsed["timestamp"] = new Date(parsed["timestamp"] as string);

    const result = alertEntrySchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("atomic write: no .tmp files left behind", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    const allFiles = readdirSync(tempDir);
    const tmpFiles = allFiles.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("applies redaction to metadata before persistence", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert({
      metadata: {
        token: "secret=mysecrettoken123",
        safe: "normal-value",
      },
    });
    emitter.emit(alert);

    const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    const filePath = join(tempDir, files[0]!);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const metadata = parsed["metadata"] as Record<string, unknown>;
    expect(metadata["safe"]).toBe("normal-value");
    expect(metadata["token"]).toContain("[REDACTED]");
  });

  it("creates directory if it does not exist", () => {
    const nestedDir = join(tempDir, "nested", "alerts");
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, nestedDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    const files = readdirSync(nestedDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("persistence failure does not break the emitter", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    // Emit multiple alerts — all should succeed
    const alert1 = createTestAlert({ message: "First alert" });
    const alert2 = createTestAlert({ message: "Second alert" });

    emitter.emit(alert1);
    emitter.emit(alert2);

    const files = readdirSync(tempDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
  });
});

describe("readPersistedAlerts", () => {
  it("reads persisted alerts", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert1 = createTestAlert({
      message: "First alert",
      clock: { now: () => new Date("2026-01-01T00:00:00Z") },
    });
    const alert2 = createTestAlert({
      message: "Second alert",
      clock: { now: () => new Date("2026-01-01T00:00:01Z") },
    });

    emitter.emit(alert1);
    emitter.emit(alert2);

    const results = readPersistedAlerts(tempDir);
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("First alert");
    expect(results[1]!.message).toBe("Second alert");
  });

  it("returns empty array for non-existent directory", () => {
    const results = readPersistedAlerts(join(tempDir, "nonexistent"));
    expect(results).toHaveLength(0);
  });

  it("skips corrupted files", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert = createTestAlert();
    emitter.emit(alert);

    // Write a corrupted file
    writeFileSync(join(tempDir, "corrupted.json"), "not valid json{{", "utf8");

    const results = readPersistedAlerts(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.alertId).toBe(alert.alertId);
  });

  it("returns alerts sorted by timestamp", () => {
    const emitter = createAlertEmitter();
    createFileAlertEmitter(emitter, tempDir);

    const alert1 = createTestAlert({
      message: "Later alert",
      clock: { now: () => new Date("2026-01-15T12:00:00.000Z") },
    });
    const alert2 = createTestAlert({
      message: "Earlier alert",
      clock: { now: () => new Date("2026-01-15T10:00:00.000Z") },
    });

    emitter.emit(alert1);
    emitter.emit(alert2);

    const results = readPersistedAlerts(tempDir);
    expect(results).toHaveLength(2);
    expect(results[0]!.message).toBe("Earlier alert");
    expect(results[1]!.message).toBe("Later alert");
  });
});
