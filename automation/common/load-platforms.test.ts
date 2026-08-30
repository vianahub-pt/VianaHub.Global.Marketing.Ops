import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadPlatforms } from "./load-platforms.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PlatformDefinition } from "./types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "platforms-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createPlatform(overrides: Partial<PlatformDefinition> & { id: string }): PlatformDefinition {
  return {
    name: overrides.id,
    country: "PT",
    locale: "pt-PT",
    url: `https://${overrides.id}.com`,
    registrationType: "form",
    automationMode: "semi-automatic",
    requiresLogin: false,
    requiresCaptcha: false,
    requiresEmailVerification: false,
    requiresPhoneVerification: false,
    enabled: true,
    ...overrides,
  };
}

describe("loadPlatforms", () => {
  it("loads global platform with correct source", () => {
    const root = join(tempDir, "global");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([createPlatform({ id: "global-platform", name: "Global Platform" })]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([]),
    );

    const platforms = loadPlatforms("PT", "operational", root);
    expect(platforms).toHaveLength(1);
    expect(platforms[0].id).toBe("global-platform");
    expect(platforms[0].source).toBe("global");
  });

  it("loads market platform with correct source", () => {
    const root = join(tempDir, "market");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([createPlatform({ id: "market-platform", name: "Market Platform" })]),
    );

    const platforms = loadPlatforms("PT", "operational", root);
    expect(platforms).toHaveLength(1);
    expect(platforms[0].id).toBe("market-platform");
    expect(platforms[0].source).toBe("market");
  });

  it("loads both global and market platforms", () => {
    const root = join(tempDir, "both");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([createPlatform({ id: "global-1", name: "Global 1" })]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([createPlatform({ id: "market-1", name: "Market 1" })]),
    );

    const platforms = loadPlatforms("PT", "operational", root);
    expect(platforms).toHaveLength(2);

    const global = platforms.find((p) => p.id === "global-1");
    const market = platforms.find((p) => p.id === "market-1");
    expect(global?.source).toBe("global");
    expect(market?.source).toBe("market");
  });

  it("throws on duplicate ID across global and market", () => {
    const root = join(tempDir, "duplicate");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([createPlatform({ id: "shared-id", name: "Global" })]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([createPlatform({ id: "shared-id", name: "Market" })]),
    );

    expect(() => loadPlatforms("PT", "operational", root)).toThrow(
      /Duplicate platform ID "shared-id" found in:/,
    );
  });

  it("removes disabled platforms in operational mode", () => {
    const root = join(tempDir, "disabled-operational");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([
        createPlatform({ id: "enabled-1", name: "Enabled", enabled: true }),
        createPlatform({ id: "disabled-1", name: "Disabled", enabled: false }),
      ]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([]),
    );

    const platforms = loadPlatforms("PT", "operational", root);
    expect(platforms).toHaveLength(1);
    expect(platforms[0].id).toBe("enabled-1");
  });

  it("includes disabled platforms in diagnostic mode", () => {
    const root = join(tempDir, "disabled-diagnostic");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([
        createPlatform({ id: "enabled-1", name: "Enabled", enabled: true }),
        createPlatform({ id: "disabled-1", name: "Disabled", enabled: false }),
      ]),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([]),
    );

    const platforms = loadPlatforms("PT", "diagnostic", root);
    expect(platforms).toHaveLength(2);
    expect(platforms.map((p) => p.id)).toContain("disabled-1");
  });

  it("returns empty array for non-existent market directory", () => {
    const root = join(tempDir, "nonexistent");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify([]),
    );

    const platforms = loadPlatforms("XX", "operational", root);
    expect(platforms).toEqual([]);
  });

  it("throws for invalid JSON in platform file", () => {
    const root = join(tempDir, "invalid-json");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      "not valid json",
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([]),
    );

    expect(() => loadPlatforms("PT", "operational", root)).toThrow("Invalid JSON in platform file");
  });

  it("throws for non-array platform file", () => {
    const root = join(tempDir, "non-array");
    mkdirSync(join(root, "data", "platforms", "global"), { recursive: true });
    mkdirSync(join(root, "data", "platforms", "PT"), { recursive: true });

    writeFileSync(
      join(root, "data", "platforms", "global", "platforms.json"),
      JSON.stringify({ not: "array" }),
    );

    writeFileSync(
      join(root, "data", "platforms", "PT", "platforms.json"),
      JSON.stringify([]),
    );

    expect(() => loadPlatforms("PT", "operational", root)).toThrow("Platform file must contain an array");
  });
});
