import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { IdempotencyKey, PayloadFingerprint, RunId } from "../domain/idempotency.js";
import type { RunRecord } from "../domain/run-record.js";
import { redactError, redactLog } from "../domain/redaction.js";

import { GoogleBusinessProfileAdapter } from "./google-business-profile-adapter.js";
import type { CreateLocalPostPayload } from "./google-business-profile-adapter.js";
import { checkGbpPreflight, loadGbpConfig } from "./access-preflight-gate.js";
import { FakeAdapter } from "./fake-adapter.js";
import { buildAdapterContext } from "./platform-adapter.js";
import type { GbpTransport } from "./gbp-http-transport.js";
import { checkLivePilotGate } from "./pilot-scope.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

vi.mock("./access-preflight-gate.js", () => ({
  checkGbpPreflight: vi.fn().mockReturnValue({
    status: "READY",
    checks: [],
    message: "All GBP preflight checks passed — adapter is ready for live execution",
  }),
  loadGbpConfig: vi.fn().mockReturnValue({
    GBP_PROJECT_ID: "fake-project-id",
    GBP_OAUTH_CLIENT_ID: "fake-client-id",
    GBP_OAUTH_CLIENT_SECRET: "fake-client-secret",
    GBP_OAUTH_REFRESH_TOKEN: "fake-refresh-token",
    GBP_ACCOUNT_ID: "fake-account-id",
    GBP_LOCATION_ID: "fake-location-id",
  }),
}));

vi.mock("./pilot-scope.js", () => ({
  checkLivePilotGate: vi.fn().mockReturnValue({
    status: "ALLOWED",
    reason: "Live pilot execution is permitted",
    checks: [
      { name: "LIVE_PILOT_ENABLED", passed: true },
      { name: "NOT_IN_CI", passed: true },
      { name: "DRY_RUN_EXECUTED", passed: true },
    ],
  }),
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const BLOCKED_PREFLIGHT_RESULT = {
  status: "BLOCKED_NEEDS_HUMAN" as const,
  checks: [
    { name: "GBP_PROJECT_ID", passed: false, detail: "GBP_PROJECT_ID missing" },
    { name: "GBP_OAUTH_CLIENT_ID", passed: false, detail: "GBP_OAUTH_CLIENT_ID missing" },
    { name: "GBP_OAUTH_CLIENT_SECRET", passed: false, detail: "GBP_OAUTH_CLIENT_SECRET missing" },
    { name: "GBP_OAUTH_REFRESH_TOKEN", passed: false, detail: "GBP_OAUTH_REFRESH_TOKEN missing" },
    { name: "GBP_ACCOUNT_ID", passed: false, detail: "GBP_ACCOUNT_ID missing" },
    { name: "GBP_LOCATION_ID", passed: false, detail: "GBP_LOCATION_ID missing" },
  ],
  message: "GBP preflight blocked: manual configuration required.",
};

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

function createValidPostPayload(
  overrides?: Partial<CreateLocalPostPayload>,
): CreateLocalPostPayload {
  return {
    summary: "Test post summary for Google Business Profile",
    callToAction: "LEARN_MORE",
    url: "https://example.com/post",
    ...overrides,
  };
}

// ─── RA-01: GoogleBusinessProfileAdapter implementa PlatformAdapter ───────────

describe("RA-01: GoogleBusinessProfileAdapter implementa PlatformAdapter", () => {
  it("tem método execute()", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    expect(typeof adapter.execute).toBe("function");
    const result = await adapter.execute(context);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("requiresManual");
  });

  it("tem método checkStatus()", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const status = await adapter.checkStatus("test-run" as RunId);
    expect(status).toHaveProperty("state");
  });

  it("tem método createLocalPost()", () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    expect(typeof adapter.createLocalPost).toBe("function");
  });
});

// ─── RA-02: createLocalPost com payload schema ──────────────────────────────

describe("RA-02: createLocalPost com payload schema", () => {
  it("aceita payload válido com todos os campos", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.postId).toBeDefined();
    expect(result.summary).toBe(payload.summary);
    expect(result.callToAction).toBe(payload.callToAction);
    expect(result.url).toBe(payload.url);
    expect(result.dryRun).toBe(true);
  });

  it("aceita payload com apenas summary (campos opcionais ausentes)", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ callToAction: undefined, url: undefined });

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.summary).toBe(payload.summary);
    expect(result.callToAction).toBeUndefined();
    expect(result.url).toBeUndefined();
  });

  it("rejeita payload com summary vazio", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ summary: "" });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "Invalid payload",
    );
  });

  it("rejeita payload com summary maior que 1500 caracteres", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ summary: "x".repeat(1501) });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "Invalid payload",
    );
  });

  it("rejeita payload com URL inválida", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ url: "not-a-valid-url" });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "Invalid payload",
    );
  });

  it("rejeita callToAction inválido", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ callToAction: "INVALID_CTA" as never });

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "Invalid payload",
    );
  });
});

// ─── RA-03: Adapter suporta modo dry-run verificável ─────────────────────────

describe("RA-03: Modo dry-run verificável", () => {
  it("execute() retorna resultado com dryRun: true em modo dry-run", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
    expect(output.postId).toContain("dry-run");
  });

  it("createLocalPost retorna dryRun: true em modo dry-run", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);

    expect(result.dryRun).toBe(true);
    expect(result.postId).toContain("dry-run-post");
  });

  it("sem credenciais, retorna BLOCKED_NEEDS_HUMAN", async () => {
    vi.mocked(checkGbpPreflight).mockReturnValueOnce(BLOCKED_PREFLIGHT_RESULT);

    const adapter = new GoogleBusinessProfileAdapter(false);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    // Without env vars, preflight blocks
    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
  });

  it("checkStatus retorna queued antes de execute()", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const status = await adapter.checkStatus("any-run" as RunId);
    expect(status.state).toBe("queued");
  });

  it("checkStatus retorna succeeded após execute bem-sucedido em dry-run", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    await adapter.execute(context);
    const status = await adapter.checkStatus(record.runId);

    expect(status.state).toBe("succeeded");
  });
});

// ─── HUMAN-002: Dry-run executa mesma validação do live ──────────────────────

describe("HUMAN-002: Dry-run executa mesma validação do live", () => {
  it("execute() dry-run chama checkGbpPreflight()", async () => {
    const mockCheckGbpPreflight = vi.mocked(checkGbpPreflight);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    await adapter.execute(context);

    expect(mockCheckGbpPreflight).toHaveBeenCalled();
  });

  it("execute() dry-run chama loadGbpConfig()", async () => {
    const mockLoadGbpConfig = vi.mocked(loadGbpConfig);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    await adapter.execute(context);

    expect(mockLoadGbpConfig).toHaveBeenCalled();
  });

  it("execute() dry-run valida payload inválido igualmente ao live", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    // Override payload with invalid data (empty summary)
    (context as { payload: unknown }).payload = { summary: "" };

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PAYLOAD_VALIDATION_ERROR");
  });

  it("execute() dry-run não chama transport.request()", async () => {
    const mockRequest = vi.fn();

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(true, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);
  });

  it("createLocalPost() dry-run chama checkGbpPreflight()", async () => {
    const mockCheckGbpPreflight = vi.mocked(checkGbpPreflight);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await adapter.createLocalPost(context, payload, true);

    expect(mockCheckGbpPreflight).toHaveBeenCalled();
  });

  it("createLocalPost() dry-run chama loadGbpConfig()", async () => {
    const mockLoadGbpConfig = vi.mocked(loadGbpConfig);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await adapter.createLocalPost(context, payload, true);

    expect(mockLoadGbpConfig).toHaveBeenCalled();
  });

  it("createLocalPost() dry-run valida payload inválido igualmente ao live", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const invalidPayload = createValidPostPayload({ summary: "" });

    await expect(adapter.createLocalPost(context, invalidPayload, true)).rejects.toThrow(
      "Invalid payload",
    );
  });

  it("createLocalPost() dry-run não chama transport.request()", async () => {
    const mockRequest = vi.fn();

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(true, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it("execute() dry-run retorna BLOCKED_NEEDS_HUMAN quando preflight bloqueado", async () => {
    vi.mocked(checkGbpPreflight).mockReturnValueOnce(BLOCKED_PREFLIGHT_RESULT);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
  });

  it("createLocalPost() dry-run lança erro quando preflight bloqueado", async () => {
    vi.mocked(checkGbpPreflight).mockReturnValueOnce(BLOCKED_PREFLIGHT_RESULT);

    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload, true)).rejects.toThrow(
      "Preflight blocked",
    );
  });
});

// ─── RA-04: FakeAdapter não satisfaz critérios do adapter real ───────────────

describe("RA-04: FakeAdapter não satisfaz critérios do adapter real", () => {
  it("FakeAdapter não tem método createLocalPost()", () => {
    const fake = new FakeAdapter("success");
    expect(typeof (fake as unknown as Record<string, unknown>).createLocalPost).toBe("undefined");
  });

  it("FakeAdapter não verifica preflight de credenciais", async () => {
    const fake = new FakeAdapter("success");
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    // FakeAdapter succeeds regardless of credentials
    const result = await fake.execute(context);
    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
  });

  it("GoogleBusinessProfileAdapter tem createLocalPost()", () => {
    const real = new GoogleBusinessProfileAdapter(true);
    expect(typeof real.createLocalPost).toBe("function");
  });

  it("GoogleBusinessProfileAdapter verifica preflight de credenciais", async () => {
    vi.mocked(checkGbpPreflight).mockReturnValueOnce(BLOCKED_PREFLIGHT_RESULT);

    const real = new GoogleBusinessProfileAdapter(false);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    // Without env vars, preflight blocks
    const result = await real.execute(context);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.requiresManual).toBe(true);
  });

  it("documentação: FakeAdapter é para testes, GoogleBusinessProfileAdapter é o real", () => {
    // This test documents the distinction between FakeAdapter and real adapter
    const fake = new FakeAdapter("success");
    const real = new GoogleBusinessProfileAdapter(true);

    // FakeAdapter: deterministic, no external dependencies, no credentials
    expect(fake).toBeInstanceOf(FakeAdapter);

    // GoogleBusinessProfileAdapter: requires credentials, has preflight gate
    expect(real).toBeInstanceOf(GoogleBusinessProfileAdapter);
    expect(typeof real.createLocalPost).toBe("function");
  });
});

// ─── SG-04: Testes verificam ausência de secrets em fixtures ─────────────────

describe("SG-04: Ausência de secrets em fixtures e dados persistidos", () => {
  it("run record fixture não contém tokens ou secrets", () => {
    const record = createValidRunRecord();
    const serialized = JSON.stringify(record);

    const sensitivePatterns = [
      /token/i,
      /secret/i,
      /password/i,
      /api[_-]?key/i,
      /credential/i,
      /authorization/i,
      /bearer/i,
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
    ];

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("adapter context não contém tokens ou secrets", async () => {
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const serialized = JSON.stringify(context);

    const sensitivePatterns = [
      /token/i,
      /secret/i,
      /password/i,
      /api[_-]?key/i,
      /credential/i,
      /authorization/i,
      /bearer/i,
    ];

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("output do adapter em dry-run não contém tokens ou secrets", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);
    const serialized = JSON.stringify(result);

    const sensitivePatterns = [
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
      /sk[_-](?:live|test|api)?[_-][a-zA-Z0-9]{20,}/, // API keys
      /password[=:]\s*[^\s,;]+/i,
    ];

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("resultado de createLocalPost em dry-run não contém tokens ou secrets", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload, true);
    const serialized = JSON.stringify(result);

    const sensitivePatterns = [
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
      /sk[_-](?:live|test|api)?[_-][a-zA-Z0-9]{20,}/, // API keys
      /password[=:]\s*[^\s,;]+/i,
    ];

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("não há env vars de credenciais no output do adapter", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);
    const outputJson = JSON.stringify(result.output ?? {});

    // Output should not contain raw credential values
    expect(outputJson).not.toContain("GBP_OAUTH_CLIENT_SECRET");
    expect(outputJson).not.toContain("GBP_OAUTH_REFRESH_TOKEN");
  });
});

// ─── T-05: Testes unitários para redação de secrets em erros e logs ──────────

describe("T-05: Redação de secrets em erros e logs do adapter real", () => {
  it("redactError redige JWT de mensagem de erro", () => {
    const error = {
      message:
        "Auth failed: token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      code: "AUTH_ERROR",
      retryable: false,
    };

    const redacted = redactError(error);

    expect(redacted.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.code).toBe("AUTH_ERROR");
    expect(redacted.retryable).toBe(false);
  });

  it("redactLog redige sensitive values em log de execução", () => {
    const logEntry = {
      adapter: "google-business-profile",
      operation: "createLocalPost",
      message: "Auth failed: password=super-secret-password-123",
      runId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const redacted = redactLog(logEntry);

    expect(redacted.message).not.toContain("super-secret-password-123");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("redactError redige API key de mensagem de erro", () => {
    const error = {
      message: "Invalid API key: EXAMPLE_API_KEY",
      code: "API_KEY_ERROR",
      retryable: false,
    };

    const redacted = redactError(error);

    expect(redacted.message).not.toContain("EXAMPLE_API_KEY");
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("redactLog redige Bearer token em log de execução", () => {
    const logEntry = {
      headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE2" },
      message: "Request failed",
    };

    const redacted = redactLog(logEntry);

    const headers = redacted.headers as Record<string, string>;
    expect(headers.Authorization).toContain("[REDACTED]");
  });

  it("redactError preserva campos code e retryable", () => {
    const error = {
      message: "Auth failed: token=secret123",
      code: "AUTH_ERROR",
      retryable: true,
    };

    const redacted = redactError(error);

    expect(redacted.code).toBe("AUTH_ERROR");
    expect(redacted.retryable).toBe(true);
  });

  it("redactLog preserva campos não-sensiveis", () => {
    const logEntry = {
      level: "error",
      timestamp: "2026-01-01T00:00:00Z",
      adapter: "google-business-profile",
      message: "Operation failed",
    };

    const redacted = redactLog(logEntry);

    expect(redacted.level).toBe("error");
    expect(redacted.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(redacted.adapter).toBe("google-business-profile");
  });

  it("redactError não muta o erro original", () => {
    const error = {
      message: "Token: eyJabc.def.ghi",
      code: "AUTH_ERROR",
    };
    const originalMessage = error.message;
    redactError(error);

    expect(error.message).toBe(originalMessage);
  });

  it("redactLog não muta a entrada original", () => {
    const entry = { message: "password=secret123" };
    const original = JSON.parse(JSON.stringify(entry));
    redactLog(entry);

    expect(entry).toEqual(original);
  });
});

// ─── SG-03: Nenhum token em RunRecord.metadata ou checkpoint ─────────────────

describe("SG-03: Nenhum token em RunRecord.metadata ou checkpoint", () => {
  it("RunRecord.metadata não contém tokens ou secrets após execução", async () => {
    const adapter = new GoogleBusinessProfileAdapter(true);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    // Simulate what orchestrator does with metadata
    const metadata = {
      lastOutput: redactLog({ output: result.output as Record<string, unknown> }),
      lastError: result.error ? redactError(result.error) : undefined,
    };

    const serialized = JSON.stringify(metadata);

    const sensitivePatterns = [
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
      /sk[_-](?:live|test|api)?[_-][a-zA-Z0-9]{20,}/, // API keys
      /password[=:]\s*[^\s,;]+/i,
    ];

    for (const pattern of sensitivePatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });
});

// ─── H-001-P2: Live execution com transport mockado ──────────────────────────

describe("H-001-P2: Live execution com transport mockado", () => {
  // Save original env values
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const originalAccountId = process.env.GBP_ACCOUNT_ID;
  const originalLocationId = process.env.GBP_LOCATION_ID;

  beforeEach(() => {
    // Clear CI flag and set required env vars for live tests
    process.env.GITHUB_ACTIONS = "false";
    process.env.GBP_ACCOUNT_ID = "test-account-123";
    process.env.GBP_LOCATION_ID = "test-location-456";
  });

  afterEach(() => {
    // Restore original env values
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
    if (originalAccountId === undefined) {
      delete process.env.GBP_ACCOUNT_ID;
    } else {
      process.env.GBP_ACCOUNT_ID = originalAccountId;
    }
    if (originalLocationId === undefined) {
      delete process.env.GBP_LOCATION_ID;
    } else {
      process.env.GBP_LOCATION_ID = originalLocationId;
    }
  });

  it("execute() chama transport.request com endpoint correto", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/test-account-123/locations/test-location-456/localPosts/post-abc-123",
        summary: "Test live post",
        callToAction: {
          actionType: "LEARN_MORE",
          url: "https://example.com",
        },
      },
      headers: { "content-type": "application/json" },
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(mockRequest).toHaveBeenCalledOnce();
    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/accounts/test-account-123/locations/test-location-456/localPosts",
      body: {
        summary: payload.summary,
        callToAction: {
          actionType: "LEARN_MORE",
          url: payload.url,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
    expect(result.output).toBeDefined();
    const output = result.output as Record<string, unknown>;
    expect(output.postId).toBe("post-abc-123");
    expect(output.summary).toBe("Test live post");
    expect(output.dryRun).toBe(false);
  });

  it("createLocalPost() chama transport.request com payload correto", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/test-account-123/locations/test-location-456/localPosts/post-xyz-789",
        summary: "Test live post",
        callToAction: { actionType: "CALL" },
      },
      headers: { "content-type": "application/json" },
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload({ callToAction: "CALL", url: undefined });

    const result = await adapter.createLocalPost(context, payload);

    expect(mockRequest).toHaveBeenCalledOnce();
    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/accounts/test-account-123/locations/test-location-456/localPosts",
      body: {
        summary: payload.summary,
        callToAction: {
          actionType: "CALL",
        },
      },
    });

    expect(result.postId).toBe("post-xyz-789");
    expect(result.summary).toBe("Test live post");
    expect(result.callToAction).toBe("CALL");
    expect(result.dryRun).toBe(false);
  });

  it("execute() mapeia response do API corretamente", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/acc1/locations/loc1/localPosts/extracted-post-id",
        summary: "API response summary",
        callToAction: {
          actionType: "SHOP",
          url: "https://shop.example.com",
        },
      },
      headers: { "content-type": "application/json" },
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.postId).toBe("extracted-post-id");
    expect(output.summary).toBe("API response summary");
    expect(output.callToAction).toBe("SHOP");
    expect(output.url).toBe("https://shop.example.com");
    expect(output.dryRun).toBe(false);
  });

  it("execute() retorna requiresManual quando transport lança erro de captcha", async () => {
    const mockRequest = vi.fn().mockRejectedValue({
      message: "CAPTCHA verification required",
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("HTTP_ERROR");
  });

  it("execute() retorna requiresManual quando transport lança erro de MFA", async () => {
    const mockRequest = vi.fn().mockRejectedValue({
      message: "Multi-factor authentication required",
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
  });

  it("execute() retorna requiresManual quando transport lança erro de ToS", async () => {
    const mockRequest = vi.fn().mockRejectedValue({
      message: "Terms of service acceptance required",
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
  });

  it("execute() aplica redactError a erros de live execution", async () => {
    const mockRequest = vi.fn().mockRejectedValue({
      message: "HTTP 500: Internal Server Error with token=secret123",
      code: "HTTP_ERROR",
      status: 500,
      retryable: true,
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.error?.message).not.toContain("secret123");
    expect(result.error?.message).toContain("[REDACTED]");
  });

  it("execute() retorna BLOCKED_NEEDS_HUMAN em CI", async () => {
    process.env.GITHUB_ACTIONS = "true";

    const mockTransport: GbpTransport = {
      request: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(mockTransport.request).not.toHaveBeenCalled();
  });

  it("createLocalPost() lança erro em CI", async () => {
    process.env.GITHUB_ACTIONS = "true";

    const mockTransport: GbpTransport = {
      request: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload)).rejects.toThrow(
      "Live execution blocked in CI",
    );
    expect(mockTransport.request).not.toHaveBeenCalled();
  });

  it("createLocalPost() lança erro com redactError em falha de ToS", async () => {
    const mockRequest = vi.fn().mockRejectedValue({
      message: "Consent required for API access with token=secret123",
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload)).rejects.toThrow(
      "Manual intervention required",
    );
  });

  it("execute() usa transport injetado ao invés de criar novo", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/acc1/locations/loc1/localPosts/post-1",
        summary: "Test",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    // Create adapter with injected transport
    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const payload = createValidPostPayload();
    const context = buildAdapterContext(record, payload);

    const result = await adapter.execute(context);

    // Transport was called — proves injected transport was used
    expect(mockRequest).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it("createLocalPost() extrai postId do campo name do response", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/111/locations/222/localPosts/extracted-id-from-name",
        summary: "Post",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload);

    expect(result.postId).toBe("extracted-id-from-name");
  });

  it("createLocalPost() usa postId fallback quando name não está presente", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        postId: "fallback-post-id",
        summary: "Post",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload);

    expect(result.postId).toBe("fallback-post-id");
  });
});

// ─── HUMAN-004: LivePilotGate conectado — nenhuma mutação sem gate ───────────

describe("HUMAN-004: LivePilotGate conectado — nenhuma mutação sem gate", () => {
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const originalAccountId = process.env.GBP_ACCOUNT_ID;
  const originalLocationId = process.env.GBP_LOCATION_ID;

  beforeEach(() => {
    process.env.GITHUB_ACTIONS = "false";
    process.env.GBP_ACCOUNT_ID = "test-account-123";
    process.env.GBP_LOCATION_ID = "test-location-456";
    vi.mocked(checkLivePilotGate).mockReturnValue({
      status: "ALLOWED",
      reason: "Live pilot execution is permitted",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });
  });

  afterEach(() => {
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
    if (originalAccountId === undefined) {
      delete process.env.GBP_ACCOUNT_ID;
    } else {
      process.env.GBP_ACCOUNT_ID = originalAccountId;
    }
    if (originalLocationId === undefined) {
      delete process.env.GBP_LOCATION_ID;
    } else {
      process.env.GBP_LOCATION_ID = originalLocationId;
    }
    vi.mocked(checkLivePilotGate).mockReturnValue({
      status: "ALLOWED",
      reason: "Live pilot execution is permitted",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });
  });

  it("execute() bloqueia live quando LIVE_PILOT_ENABLED não está definido", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED",
      reason: "Live pilot blocked: LIVE_PILOT_ENABLED",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: false, detail: "LIVE_PILOT_ENABLED is not 'true'" },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("execute() bloqueia live quando detectado CI", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED_NEEDS_HUMAN",
      reason: "Live pilot blocked: NOT_IN_CI",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: false, detail: "CI environment detected" },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("execute() bloqueia live quando dry-run não foi executado", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED_NEEDS_HUMAN",
      reason: "Live pilot blocked: DRY_RUN_EXECUTED",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: false, detail: "Dry-run must be executed first" },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("execute() bloqueia live quando múltiplos checks falham", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED",
      reason: "Live pilot blocked: LIVE_PILOT_ENABLED, DRY_RUN_EXECUTED",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: false, detail: "not enabled" },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: false, detail: "not executed" },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);

    const result = await adapter.execute(context);

    expect(result.success).toBe(false);
    expect(result.requiresManual).toBe(true);
    expect(result.error?.code).toBe("BLOCKED_NEEDS_HUMAN");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("createLocalPost() bloqueia live quando LIVE_PILOT_ENABLED não está definido", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED",
      reason: "Live pilot blocked: LIVE_PILOT_ENABLED",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: false, detail: "not enabled" },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload)).rejects.toThrow("Live pilot blocked");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("createLocalPost() bloqueia live quando detectado CI", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED_NEEDS_HUMAN",
      reason: "Live pilot blocked: NOT_IN_CI",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: false, detail: "CI environment detected" },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload)).rejects.toThrow("Live pilot blocked");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("createLocalPost() bloqueia live quando dry-run não foi executado", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "BLOCKED_NEEDS_HUMAN",
      reason: "Live pilot blocked: DRY_RUN_EXECUTED",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: false, detail: "Dry-run must be executed first" },
      ],
    });

    const mockRequest = vi.fn();
    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    await expect(adapter.createLocalPost(context, payload)).rejects.toThrow("Live pilot blocked");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("execute() permite live quando checkLivePilotGate retorna ALLOWED", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "ALLOWED",
      reason: "Live pilot execution is permitted",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/acc1/locations/loc1/localPosts/post-1",
        summary: "Test",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record, createValidPostPayload());

    const result = await adapter.execute(context);

    expect(result.success).toBe(true);
    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it("createLocalPost() permite live quando checkLivePilotGate retorna ALLOWED", async () => {
    vi.mocked(checkLivePilotGate).mockReturnValueOnce({
      status: "ALLOWED",
      reason: "Live pilot execution is permitted",
      checks: [
        { name: "LIVE_PILOT_ENABLED", passed: true },
        { name: "NOT_IN_CI", passed: true },
        { name: "DRY_RUN_EXECUTED", passed: true },
      ],
    });

    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/acc1/locations/loc1/localPosts/post-1",
        summary: "Test",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record);
    const payload = createValidPostPayload();

    const result = await adapter.createLocalPost(context, payload);

    expect(result.postId).toBe("post-1");
    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it("execute() dry-live-dry-live: gate permite live após dry-run bem-sucedido", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        name: "accounts/acc1/locations/loc1/localPosts/post-1",
        summary: "Test",
      },
      headers: {},
    });

    const mockTransport: GbpTransport = {
      request: mockRequest,
      isReady: vi.fn().mockReturnValue(true),
    };

    const adapter = new GoogleBusinessProfileAdapter(true, mockTransport);
    const record = createValidRunRecord();
    const context = buildAdapterContext(record, createValidPostPayload());

    // First: dry-run succeeds
    const dryResult = await adapter.execute(context);
    expect(dryResult.success).toBe(true);
    const output = dryResult.output as Record<string, unknown>;
    expect(output.dryRun).toBe(true);

    // Now switch to live mode
    const liveAdapter = new GoogleBusinessProfileAdapter(false, mockTransport);
    // Transfer dry-run state (in real usage, same adapter instance or shared state)
    // For test purposes, mock gate to ALLOWED
    const liveContext = buildAdapterContext(record, createValidPostPayload());
    const liveResult = await liveAdapter.execute(liveContext);

    expect(liveResult.success).toBe(true);
    expect(mockRequest).toHaveBeenCalledOnce();
  });
});
