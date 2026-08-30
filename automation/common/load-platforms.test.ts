import { describe, it, expect } from "vitest";
import { loadPlatforms } from "./load-platforms.js";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

describe("loadPlatforms", () => {
  it("loads platforms for a market", () => {
    const platforms = loadPlatforms("PT", "operational", ROOT);
    expect(Array.isArray(platforms)).toBe(true);
  });

  it("loads platforms in diagnostic mode", () => {
    const platforms = loadPlatforms("PT", "diagnostic", ROOT);
    expect(Array.isArray(platforms)).toBe(true);
  });

  it("returns empty array for non-existent market directory", () => {
    const platforms = loadPlatforms("XX", "operational", ROOT);
    expect(platforms).toEqual([]);
  });
});
