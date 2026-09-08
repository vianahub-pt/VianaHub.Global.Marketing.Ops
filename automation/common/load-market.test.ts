import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadMarket } from "./load-market.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "market-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadMarket", () => {
  it("loads a valid market", () => {
    const root = join(tempDir, "valid");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "targets.json"),
      JSON.stringify({
        brandId: "test-brand",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
      }),
    );

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "PT.csv"),
      "platform_id,enabled,priority,status,listing_url,last_checked,notes\n",
    );

    const market = loadMarket("test-brand", "PT", root);
    expect(market.target.country).toBe("PT");
    expect(market.target.locale).toBe("pt-PT");
    expect(market.target.enabled).toBe(true);
    expect(Array.isArray(market.listings)).toBe(true);
  });

  it("throws for non-existent market", () => {
    const root = join(tempDir, "no-market");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "targets.json"),
      JSON.stringify({
        brandId: "test-brand",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
      }),
    );

    expect(() => loadMarket("test-brand", "XX", root)).toThrow('Market "XX" not found');
  });

  it("throws for disabled market", () => {
    const root = join(tempDir, "disabled-market");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "targets.json"),
      JSON.stringify({
        brandId: "test-brand",
        markets: [{ country: "ZZ", locale: "zz-ZZ", enabled: false, priority: "tertiary" }],
      }),
    );

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "ZZ.csv"),
      "platform_id,enabled,priority,status,listing_url,last_checked,notes\n",
    );

    expect(() => loadMarket("test-brand", "ZZ", root)).toThrow('Market "ZZ" is disabled');
  });

  it("throws for brandId mismatch", () => {
    const root = join(tempDir, "brand-mismatch");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "targets.json"),
      JSON.stringify({
        brandId: "different-brand",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
      }),
    );

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "PT.csv"),
      "platform_id,enabled,priority,status\n",
    );

    expect(() => loadMarket("test-brand", "PT", root)).toThrow("brandId mismatch");
  });

  it("throws for invalid JSON in targets file", () => {
    const root = join(tempDir, "invalid-json");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(join(root, "brands", "test-brand", "markets", "targets.json"), "not json");

    expect(() => loadMarket("test-brand", "PT", root)).toThrow("Invalid JSON in targets file");
  });

  it("throws for missing CSV file", () => {
    const root = join(tempDir, "missing-csv");
    mkdirSync(join(root, "brands", "test-brand", "markets"), { recursive: true });

    writeFileSync(
      join(root, "brands", "test-brand", "markets", "targets.json"),
      JSON.stringify({
        brandId: "test-brand",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
      }),
    );

    expect(() => loadMarket("test-brand", "PT", root)).toThrow("Market CSV not found");
  });
});
