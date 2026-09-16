import { describe, expect, it } from "vitest";

import type { RunId } from "../domain/idempotency.js";
import type { AdapterResult, PlatformAdapter, StatusCheckResult } from "./platform-adapter.js";

import { synchronizeStatus, resolveAdapterState } from "./status-sync.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createRunId(value: string): RunId {
  return value as RunId;
}

function createFakeAdapter(checkStatusResult: StatusCheckResult): PlatformAdapter {
  return {
    async execute(): Promise<AdapterResult> {
      return { success: true, requiresManual: false };
    },
    async checkStatus(): Promise<StatusCheckResult> {
      return checkStatusResult;
    },
  };
}

// ─── synchronizeStatus — consistent ──────────────────────────────────────────

describe("synchronizeStatus — consistent state", () => {
  it("maintains result when checkStatus returns consistent state (succeeded)", async () => {
    const adapter = createFakeAdapter({ state: "succeeded" });
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-1"), result);

    expect(reconciled.state).toBe("succeeded");
    expect(reconciled.statusCheck.state).toBe("succeeded");
  });

  it("maintains result when checkStatus returns consistent state (waiting_manual)", async () => {
    const adapter = createFakeAdapter({ state: "waiting_manual" });
    const result: AdapterResult = { success: false, requiresManual: true };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-2"), result);

    expect(reconciled.state).toBe("waiting_manual");
  });

  it("maintains result when checkStatus returns consistent state (failed)", async () => {
    const adapter = createFakeAdapter({ state: "failed" });
    const result: AdapterResult = {
      success: false,
      error: { message: "Error occurred" },
      requiresManual: false,
    };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-3"), result);

    expect(reconciled.state).toBe("failed");
  });
});

// ─── synchronizeStatus — contradictions ──────────────────────────────────────

describe("synchronizeStatus — contradictions", () => {
  it("adapter says succeeded, status says failed → prevails failed", async () => {
    const adapter = createFakeAdapter({
      state: "failed",
      error: { message: "Remote failure" },
    });
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-4"), result);

    expect(reconciled.state).toBe("failed");
    expect(reconciled.error?.message).toBe("Remote failure");
  });

  it("adapter says failed, status says succeeded → prevails failed", async () => {
    const adapter = createFakeAdapter({
      state: "succeeded",
      output: { remoteData: "confirmed" },
    });
    const result: AdapterResult = {
      success: false,
      error: { message: "Local error" },
      requiresManual: false,
    };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-5"), result);

    expect(reconciled.state).toBe("failed");
    expect(reconciled.output).toBeUndefined();
  });

  it("adapter says failed, status says waiting_manual → prevails failed", async () => {
    const adapter = createFakeAdapter({ state: "waiting_manual" });
    const result: AdapterResult = {
      success: false,
      error: { message: "Local error" },
      requiresManual: false,
    };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-6"), result);

    expect(reconciled.state).toBe("failed");
  });

  it("adapter says succeeded, status says waiting_manual → prevails waiting_manual", async () => {
    const adapter = createFakeAdapter({ state: "waiting_manual" });
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-7"), result);

    expect(reconciled.state).toBe("waiting_manual");
  });

  it("adapter says succeeded, status says running → prevails running", async () => {
    const adapter = createFakeAdapter({ state: "running" });
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-8"), result);

    expect(reconciled.state).toBe("running");
  });
});

// ─── synchronizeStatus — metadata ────────────────────────────────────────────

describe("synchronizeStatus — metadata", () => {
  it("includes statusCheck in the result", async () => {
    const statusCheck: StatusCheckResult = {
      state: "succeeded",
      output: { details: "ok" },
    };
    const adapter = createFakeAdapter(statusCheck);
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-9"), result);

    expect(reconciled.statusCheck).toEqual(statusCheck);
  });

  it("preserves remote output when remote wins with richer data", async () => {
    const adapter = createFakeAdapter({
      state: "failed",
      output: { remotePayload: "data" },
    });
    const result: AdapterResult = { success: true, requiresManual: false };

    const reconciled = await synchronizeStatus(adapter, createRunId("run-10"), result);

    expect(reconciled.output).toEqual({ remotePayload: "data" });
  });
});

// ─── resolveAdapterState ─────────────────────────────────────────────────────

describe("resolveAdapterState", () => {
  it("returns waiting_manual when requiresManual is true", () => {
    const result: AdapterResult = { success: false, requiresManual: true };
    expect(resolveAdapterState(result)).toBe("waiting_manual");
  });

  it("returns succeeded when success is true and requiresManual is false", () => {
    const result: AdapterResult = { success: true, requiresManual: false };
    expect(resolveAdapterState(result)).toBe("succeeded");
  });

  it("returns failed when success is false and requiresManual is false", () => {
    const result: AdapterResult = { success: false, requiresManual: false };
    expect(resolveAdapterState(result)).toBe("failed");
  });
});
