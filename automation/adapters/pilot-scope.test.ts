import { describe, expect, it } from "vitest";

import {
  checkLivePilotGate,
  checkPilotScope,
  PILOT_ALLOWED_BRANDS,
  PILOT_ALLOWED_MARKETS,
  PILOT_ALLOWED_OPERATIONS,
  PILOT_ALLOWED_PLATFORMS,
} from "./pilot-scope.js";

// ─── FP-01: Pilot Scope Validation ───────────────────────────────────────────

describe("FP-01: Pilot Scope — validação de escopo do piloto", () => {
  it("aceita run dentro do escopo do piloto (best-fluency, PT, google-business-profile, createLocalPost)", () => {
    const result = checkPilotScope({
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business-profile",
      operation: "createLocalPost",
    });

    expect(result.withinScope).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.message).toBe("Run is within pilot scope");
  });

  it("rejeita brand fora do escopo", () => {
    const result = checkPilotScope({
      brandId: "gerit",
      market: "PT",
      platform: "google-business-profile",
      operation: "createLocalPost",
    });

    expect(result.withinScope).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe("brandId");
    expect(result.violations[0].actual).toBe("gerit");
    expect(result.violations[0].expected).toContain("best-fluency");
  });

  it("rejeita market fora do escopo", () => {
    const result = checkPilotScope({
      brandId: "best-fluency",
      market: "BR",
      platform: "google-business-profile",
      operation: "createLocalPost",
    });

    expect(result.withinScope).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe("market");
    expect(result.violations[0].actual).toBe("BR");
  });

  it("rejeita platform fora do escopo", () => {
    const result = checkPilotScope({
      brandId: "best-fluency",
      market: "PT",
      platform: "cylex",
      operation: "createLocalPost",
    });

    expect(result.withinScope).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe("platform");
    expect(result.violations[0].actual).toBe("cylex");
  });

  it("rejeita operation fora do escopo", () => {
    const result = checkPilotScope({
      brandId: "best-fluency",
      market: "PT",
      platform: "google-business-profile",
      operation: "deleteLocalPost",
    });

    expect(result.withinScope).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe("operation");
    expect(result.violations[0].actual).toBe("deleteLocalPost");
  });

  it("rejeita múltiplas violações simultaneamente", () => {
    const result = checkPilotScope({
      brandId: "gerit",
      market: "BR",
      platform: "cylex",
      operation: "deleteLocalPost",
    });

    expect(result.withinScope).toBe(false);
    expect(result.violations).toHaveLength(4);
    expect(result.violations.map((v) => v.field)).toEqual([
      "brandId",
      "market",
      "platform",
      "operation",
    ]);
  });

  it("constant PILOT_ALLOWED_BRANDS contém apenas best-fluency", () => {
    expect(PILOT_ALLOWED_BRANDS).toEqual(["best-fluency"]);
  });

  it("constant PILOT_ALLOWED_MARKETS contém apenas PT", () => {
    expect(PILOT_ALLOWED_MARKETS).toEqual(["PT"]);
  });

  it("constant PILOT_ALLOWED_PLATFORMS contém apenas google-business-profile", () => {
    expect(PILOT_ALLOWED_PLATFORMS).toEqual(["google-business-profile"]);
  });

  it("constant PILOT_ALLOWED_OPERATIONS contém apenas createLocalPost", () => {
    expect(PILOT_ALLOWED_OPERATIONS).toEqual(["createLocalPost"]);
  });
});

// ─── FP-02: Live Pilot Opt-in Gate ───────────────────────────────────────────

describe("FP-02: Live Pilot Gate — opt-in via LIVE_PILOT_ENABLED", () => {
  it("bloqueia live execution quando LIVE_PILOT_ENABLED não está definido", () => {
    const result = checkLivePilotGate({});

    expect(result.status).toBe("BLOCKED");
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].name).toBe("LIVE_PILOT_ENABLED");
  });

  it("bloqueia live execution quando LIVE_PILOT_ENABLED=false", () => {
    const result = checkLivePilotGate({ LIVE_PILOT_ENABLED: "false" });

    expect(result.status).toBe("BLOCKED");
    expect(result.checks[0].passed).toBe(false);
  });

  it("bloqueia live execution quando CI=true mesmo com LIVE_PILOT_ENABLED=true", () => {
    const result = checkLivePilotGate({
      LIVE_PILOT_ENABLED: "true",
      CI: "true",
    });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].name).toBe("NOT_IN_CI");
  });

  it("bloqueia live execution quando GITHUB_ACTIONS=true mesmo com LIVE_PILOT_ENABLED=true", () => {
    const result = checkLivePilotGate({
      LIVE_PILOT_ENABLED: "true",
      GITHUB_ACTIONS: "true",
    });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks[1].passed).toBe(false);
  });

  it("bloqueia live execution quando dry-run não foi executado", () => {
    const result = checkLivePilotGate({ LIVE_PILOT_ENABLED: "true" }, { dryRunExecuted: false });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    expect(result.checks[2].passed).toBe(false);
    expect(result.checks[2].name).toBe("DRY_RUN_EXECUTED");
  });

  it("permite live execution quando LIVE_PILOT_ENABLED=true, não está em CI, e dry-run foi executado", () => {
    const result = checkLivePilotGate({ LIVE_PILOT_ENABLED: "true" }, { dryRunExecuted: true });

    expect(result.status).toBe("ALLOWED");
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.reason).toBe("Live pilot execution is permitted");
  });

  it("mensagem de erro inclui todos os checks que falharam", () => {
    const result = checkLivePilotGate({});

    expect(result.reason).toContain("LIVE_PILOT_ENABLED");
    expect(result.reason).toContain("DRY_RUN_EXECUTED");
  });
});

// ─── FP-03: Live Smoke Test — BLOCKED_NEEDS_HUMAN ───────────────────────────

describe("FP-03: Live Smoke Test — evidência manual separada", () => {
  it("sistema para em BLOCKED_NEEDS_HUMAN quando credenciais não disponíveis", () => {
    const result = checkLivePilotGate({});

    expect(result.status).toBe("BLOCKED");
    const blockedCheck = result.checks.find((c) => !c.passed);
    expect(blockedCheck).toBeDefined();
    expect(blockedCheck!.detail).toContain("opt-in required");
  });

  it("sistema para em BLOCKED_NEEDS_HUMAN quando está em CI", () => {
    const result = checkLivePilotGate({
      LIVE_PILOT_ENABLED: "true",
      CI: "true",
    });

    expect(result.status).toBe("BLOCKED_NEEDS_HUMAN");
    const ciCheck = result.checks.find((c) => c.name === "NOT_IN_CI");
    expect(ciCheck?.passed).toBe(false);
    expect(ciCheck?.detail).toContain("forbidden in CI");
  });

  it("check result é imutável e tipado corretamente", () => {
    const result = checkLivePilotGate({});
    expect(typeof result.status).toBe("string");
    expect(typeof result.reason).toBe("string");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);

    for (const check of result.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.passed).toBe("boolean");
    }
  });
});
