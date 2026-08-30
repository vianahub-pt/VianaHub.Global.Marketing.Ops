import { describe, it, expect } from "vitest";
import { loadBrand } from "./load-brand.js";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

describe("loadBrand", () => {
  it("loads a valid brand", () => {
    const brand = loadBrand("best-fluency", ROOT);
    expect(brand.id).toBe("best-fluency");
    expect(brand.name).toBe("Best Fluency");
    expect(brand.website).toBe("https://bestfluency.pt");
  });

  it("throws for non-existent brand", () => {
    expect(() => loadBrand("non-existent", ROOT)).toThrow("Brand profile not found");
  });

  it("throws for missing required field", () => {
    expect(() => loadBrand("gerit", ROOT)).toThrow(/Missing required field/);
  });
});
