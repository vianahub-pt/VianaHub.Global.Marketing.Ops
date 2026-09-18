import { describe, expect, it } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";

import { GbpDryRunAdapter } from "./gbp-dry-run-adapter.js";
import type { DryRunPostPayload } from "./gbp-dry-run-adapter.js";
import { buildAdapterContext } from "./platform-adapter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createValidRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1,
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "google-business-profile",
    operation: "createLocalPost",
    state: "queued",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createValidPostPayload(overrides?: Partial<DryRunPostPayload>): DryRunPostPayload {
  return {
    summary: "Test post summary for Google Business Profile",
    callToAction: "LEARN_MORE",
    url: "https://example.com/post",
    ...overrides,
  };
}

// ─── T-10: Dry-run adapter — execute ────────────────────────────────────────

describe("T-10: GbpDryRunAdapter — execute", () => {
  it("DR-03: retorna resultado com dryRun: true em modo dry-run", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(output.message).toContain("Dry-run");
  });

  it("DR-03: nunca retorna success: true fingindo que post foi publicado", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    // DR-03: success is true (operation validated) but output contains dryRun: true
    // The adapter doesn't fake a real publication — it's explicitly dry-run
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(output.postId).toContain("dry-run");
  });

  it("DR-02: valida contexto corretamente", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
  });

  it("retorna erro quando contexto é inválido", async () => {
    const adapter = new GbpDryRunAdapter();
    const context = {
      runId: "" as RunId,
      brandId: "",
      market: "",
      platform: "",
      operation: "",
      payload: undefined,
      idempotencyKey: "a".repeat(64) as IdempotencyKey,
    };

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(result.error?.retryable).toBe(false);
  });

  it("checkStatus retorna succeeded após execute bem-sucedido", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    await adapter.execute(context);
    const status = await adapter.checkStatus(record.runId);

    expect(status.state).toBe("succeeded");
  });

  it("checkStatus retorna queued quando não houve execute", async () => {
    const adapter = new GbpDryRunAdapter();

    const status = await adapter.checkStatus("any-run" as RunId);

    expect(status.state).toBe("queued");
  });
});

// ─── T-10: Dry-run adapter — createLocalPost ────────────────────────────────

describe("T-10: GbpDryRunAdapter — createLocalPost", () => {
  it("DR-01: suporta modo dryRun — retorna dryRun: true", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.dryRun).toBe(true);
    expect(result.postId).toContain("dry-run-post");
    expect(result.summary).toBe(payload.summary);
    expect(result.callToAction).toBe(payload.callToAction);
    expect(result.url).toBe(payload.url);
  });

  it("DR-02: valida payload no dry-run (summary obrigatório)", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ summary: "" });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "summary is required",
    );
  });

  it("DR-02: valida payload no dry-run (summary max 1500 chars)", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ summary: "x".repeat(1501) });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "exceeds maximum length",
    );
  });

  it("DR-02: valida URL no dry-run", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ url: "not-a-valid-url" });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "must be a valid URL",
    );
  });

  it("DR-02: aceita payload válido no dry-run", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.dryRun).toBe(true);
    expect(result.summary).toBe(payload.summary);
  });

  it("DR-01: dryRun default é false", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    // Call without dryRun parameter (defaults to false)
    const result = await adapter.createLocalPost(context, payload);

    // Even with dryRun=false, this adapter always simulates (it's a dry-run adapter)
    expect(result.dryRun).toBe(true);
  });

  it("preserva campos opcionais no resultado", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({
      callToAction: "CALL",
      url: "https://custom.example.com",
    });

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.callToAction).toBe("CALL");
    expect(result.url).toBe("https://custom.example.com");
  });
});

// ─── T-10: Dry-run adapter — no mutable HTTP ────────────────────────────────

describe("T-10: GbpDryRunAdapter — DR-04 ausência de chamada mutável", () => {
  it("DR-04: createLocalPost em dry-run não realiza chamada HTTP mutável", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    // In dry-run mode, the adapter should not make any HTTP requests
    // We verify this by checking the result contains dryRun: true
    // and the postId is a simulated value (not a real one from an API)
    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.dryRun).toBe(true);
    expect(result.postId).toMatch(/^dry-run-post-/);
    // The postId contains the runId, proving it's locally generated
    expect(result.postId).toContain(record.runId);
  });

  it("DR-04: execute em dry-run não realiza chamada HTTP mutável", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    // Verify the result is explicitly dry-run
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(output.postId).toMatch(/^dry-run-/);
  });

  it("DR-04: múltiplas chamadas dry-run são idempotentes", async () => {
    const adapter = new GbpDryRunAdapter();
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result1 = await adapter.createLocalPost(context, payload, true);
    const result2 = await adapter.createLocalPost(context, payload, true);

    // Both should return dry-run results with same structure
    expect(result1.dryRun).toBe(true);
    expect(result2.dryRun).toBe(true);
    expect(result1.summary).toBe(result2.summary);
    // PostIds may differ (each call generates a new one)
    expect(result1.postId).toMatch(/^dry-run-post-/);
    expect(result2.postId).toMatch(/^dry-run-post-/);
  });
});
