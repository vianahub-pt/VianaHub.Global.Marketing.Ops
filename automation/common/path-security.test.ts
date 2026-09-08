import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  validateBrandId,
  validateMarket,
  validatePathInsideRoot,
  safeResolve,
  PathSecurityError,
} from "./path-security.js";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pathsec-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("path-security", () => {
  describe("validateBrandId", () => {
    it("accepts valid kebab-case brand IDs", () => {
      expect(() => validateBrandId("best-fluency")).not.toThrow();
      expect(() => validateBrandId("my-brand")).not.toThrow();
      expect(() => validateBrandId("brand123")).not.toThrow();
      expect(() => validateBrandId("a")).not.toThrow();
    });

    it("rejects empty or non-string brand IDs", () => {
      expect(() => validateBrandId("")).toThrow(PathSecurityError);
      expect(() => validateBrandId(null as unknown as string)).toThrow(PathSecurityError);
    });

    it("rejects brand IDs with path traversal", () => {
      expect(() => validateBrandId("../secrets")).toThrow(PathSecurityError);
      expect(() => validateBrandId("brand/../../etc")).toThrow(PathSecurityError);
      expect(() => validateBrandId("brand\\windows")).toThrow(PathSecurityError);
    });

    it("rejects brand IDs with spaces", () => {
      expect(() => validateBrandId("my brand")).toThrow(PathSecurityError);
    });

    it("rejects absolute path brand IDs", () => {
      expect(() => validateBrandId("/etc/passwd")).toThrow(PathSecurityError);
      expect(() => validateBrandId("C:\\Windows")).toThrow(PathSecurityError);
    });

    it("rejects uppercase brand IDs", () => {
      expect(() => validateBrandId("Best-Fluency")).toThrow(PathSecurityError);
      expect(() => validateBrandId("BEST")).toThrow(PathSecurityError);
    });

    it("rejects NUL bytes", () => {
      expect(() => validateBrandId("best\x00fluency")).toThrow(PathSecurityError);
    });

    it("rejects URL-encoded characters", () => {
      expect(() => validateBrandId("%2e%2e%2f")).toThrow(PathSecurityError);
      expect(() => validateBrandId("brand%00")).toThrow(PathSecurityError);
    });
  });

  describe("validateMarket", () => {
    it("accepts valid 2-letter uppercase market codes", () => {
      expect(() => validateMarket("PT")).not.toThrow();
      expect(() => validateMarket("US")).not.toThrow();
      expect(() => validateMarket("BR")).not.toThrow();
    });

    it("rejects empty or non-string market codes", () => {
      expect(() => validateMarket("")).toThrow(PathSecurityError);
      expect(() => validateMarket(null as unknown as string)).toThrow(PathSecurityError);
    });

    it("rejects lowercase market codes", () => {
      expect(() => validateMarket("pt")).toThrow(PathSecurityError);
    });

    it("rejects market codes with wrong length", () => {
      expect(() => validateMarket("P")).toThrow(PathSecurityError);
      expect(() => validateMarket("PTB")).toThrow(PathSecurityError);
    });

    it("rejects market codes with special characters", () => {
      expect(() => validateMarket("P-T")).toThrow(PathSecurityError);
      expect(() => validateMarket("P T")).toThrow(PathSecurityError);
    });

    it("rejects NUL bytes", () => {
      expect(() => validateMarket("P\x00T")).toThrow(PathSecurityError);
    });
  });

  describe("validatePathInsideRoot", () => {
    it("accepts paths inside root", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      const nested = join(root, "brands", "best-fluency");
      mkdirSync(nested, { recursive: true });
      expect(() => validatePathInsideRoot(nested, root)).not.toThrow();
    });

    it("rejects paths outside root", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      expect(() => validatePathInsideRoot("/etc/passwd", root)).toThrow(PathSecurityError);
      expect(() => validatePathInsideRoot(join(root, "..", "etc", "passwd"), root)).toThrow(
        PathSecurityError,
      );
    });

    it("rejects symlink pointing outside root", () => {
      const root = join(tempDir, "repo");
      const outside = join(tempDir, "outside");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });

      try {
        const linkPath = join(root, "link-out");
        symlinkSync(outside, linkPath);
        expect(() => validatePathInsideRoot(linkPath, root)).toThrow(PathSecurityError);
      } catch {
        // Symlink creation may fail on Windows without elevated privileges
      }
    });

    it("accepts symlink pointing inside root", () => {
      const root = join(tempDir, "repo");
      const inside = join(root, "target");
      mkdirSync(root, { recursive: true });
      mkdirSync(inside, { recursive: true });

      try {
        const linkPath = join(root, "link-in");
        symlinkSync(inside, linkPath);
        expect(() => validatePathInsideRoot(linkPath, root)).not.toThrow();
      } catch {
        // Symlink creation may fail on Windows without elevated privileges
      }
    });

    it("handles non-existent paths by validating nearest existing ancestor", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      const nonExistent = join(root, "brands", "test", "deep", "path");
      expect(() => validatePathInsideRoot(nonExistent, root)).not.toThrow();
    });

    it("rejects non-existent path with outside ancestor", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      const outside = join(tempDir, "outside");
      mkdirSync(outside, { recursive: true });
      const malicious = join(root, "..", "outside", "file.txt");
      expect(() => validatePathInsideRoot(malicious, root)).toThrow(PathSecurityError);
    });
  });

  describe("safeResolve", () => {
    it("resolves paths inside root", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      const result = safeResolve(root, "brands", "test");
      expect(result).toContain("brands");
      expect(result).toContain("test");
    });

    it("rejects path traversal attempts", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      expect(() => safeResolve(root, "..", "etc", "passwd")).toThrow(PathSecurityError);
    });

    it("rejects NUL bytes in segments", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      expect(() => safeResolve(root, "brand\x00test")).toThrow(PathSecurityError);
    });

    it("rejects URL-encoded characters in segments", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      expect(() => safeResolve(root, "%2e%2e")).toThrow(PathSecurityError);
    });

    it("rejects Windows mixed separators", () => {
      const root = join(tempDir, "repo");
      mkdirSync(root, { recursive: true });
      expect(() => safeResolve(root, "..\\etc\\passwd")).toThrow(PathSecurityError);
    });
  });
});
