import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBrand } from "./load-brand.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brand-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadBrand", () => {
  it("loads a valid brand", () => {
    const root = join(tempDir, "valid");
    mkdirSync(join(root, "brands", "best-fluency", "business-profile"), { recursive: true });

    writeFileSync(
      join(root, "brands", "best-fluency", "business-profile", "master-data.json"),
      JSON.stringify({
        id: "best-fluency",
        name: "Best Fluency",
        website: "https://bestfluency.pt",
      }),
    );

    const brand = loadBrand("best-fluency", root);
    expect(brand.id).toBe("best-fluency");
    expect(brand.name).toBe("Best Fluency");
    expect(brand.website).toBe("https://bestfluency.pt");
  });

  it("throws for non-existent brand", () => {
    expect(() => loadBrand("non-existent", tempDir)).toThrow("Brand profile not found");
  });

  it("throws for missing required field (name)", () => {
    const root = join(tempDir, "missing-name");
    mkdirSync(join(root, "brands", "invalid-brand", "business-profile"), { recursive: true });

    writeFileSync(
      join(root, "brands", "invalid-brand", "business-profile", "master-data.json"),
      JSON.stringify({
        id: "invalid-brand",
        website: "https://invalid.com",
      }),
    );

    expect(() => loadBrand("invalid-brand", root)).toThrow(/Missing required field "name"/);
  });

  it("throws for missing required field (website)", () => {
    const root = join(tempDir, "missing-website");
    mkdirSync(join(root, "brands", "invalid-brand", "business-profile"), { recursive: true });

    writeFileSync(
      join(root, "brands", "invalid-brand", "business-profile", "master-data.json"),
      JSON.stringify({
        id: "invalid-brand",
        name: "Invalid Brand",
      }),
    );

    expect(() => loadBrand("invalid-brand", root)).toThrow(/Missing required field "website"/);
  });

  it("loads brand with optional fields", () => {
    const root = join(tempDir, "with-optionals");
    mkdirSync(join(root, "brands", "full-brand", "business-profile"), { recursive: true });

    writeFileSync(
      join(root, "brands", "full-brand", "business-profile", "master-data.json"),
      JSON.stringify({
        id: "full-brand",
        name: "Full Brand",
        website: "https://full.com",
        email: "info@full.com",
        phone: "+351123456789",
        address: { street: "Rua Test", city: "Lisboa", country: "PT" },
        social: { instagram: "https://instagram.com/full" },
      }),
    );

    const brand = loadBrand("full-brand", root);
    expect(brand.email).toBe("info@full.com");
    expect(brand.phone).toBe("+351123456789");
    expect(brand.address?.city).toBe("Lisboa");
    expect(brand.social?.instagram).toBe("https://instagram.com/full");
  });
});
