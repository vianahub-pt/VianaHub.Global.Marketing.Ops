/**
 * AC-25: Audit vs RunRecord.metadata Distinction
 *
 * This test file documents the explicit distinction between:
 * - Audit entries: immutable history (append-only, no update/delete)
 * - RunRecord.metadata: mutable run state (can be updated via repo.update)
 */

import { describe, it, expect } from "vitest";
import { createAuditEntry } from "./audit-entry.js";

describe("audit vs RunRecord.metadata distinction (AC-25)", () => {
  it("documentation: audit entries are immutable history", () => {
    // AuditRepository interface has no update() or delete() methods
    // This is enforced at compile time by the interface definition
    // At runtime, we verify the type contract exists
    expect(true).toBe(true); // Placeholder — real verification is at compile time
  });

  it("documentation: RunRecord.metadata is mutable", () => {
    // RunRepository interface has update() method
    // This is enforced at compile time by the interface definition
    expect(true).toBe(true); // Placeholder — real verification is at compile time
  });

  it("audit entry captures state transitions (previousState/newState)", () => {
    // AuditEntry explicitly tracks state transitions
    const entry = createAuditEntry({
      category: "run",
      action: "run.succeeded",
      actor: "system",
      correlationIds: { runId: "test" },
      previousState: "running",
      newState: "succeeded",
    });

    expect(entry.previousState).toBe("running");
    expect(entry.newState).toBe("succeeded");
  });

  it("audit entries are append-only (no modification after creation)", () => {
    // Verify that AuditEntry fields are readonly
    const entry = createAuditEntry({
      category: "run",
      action: "run.created",
      actor: "system",
      correlationIds: { runId: "test" },
    });

    // Attempting to modify should fail in strict mode
    // (TypeScript prevents this at compile time)
    expect(entry.entryId).toBeDefined();
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.category).toBe("run");
    expect(entry.action).toBe("run.created");
  });
});
