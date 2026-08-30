import { describe, it, expect } from "vitest";
import { loadMarket } from "./load-market.js";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

describe("loadMarket", () => {
  it("loads a valid market", () => {
    const market = loadMarket("best-fluency", "PT", ROOT);
    expect(market.target.country).toBe("PT");
    expect(market.target.locale).toBe("pt-PT");
    expect(market.target.enabled).toBe(true);
    expect(Array.isArray(market.listings)).toBe(true);
  });

  it("throws for non-existent market", () => {
    expect(() => loadMarket("best-fluency", "XX", ROOT)).toThrow('Market "XX" not found');
  });

  it("throws for disabled market", () => {
    expect(() => loadMarket("best-fluency", "ZZ", ROOT)).toThrow('Market "ZZ" not found');
  });
});
