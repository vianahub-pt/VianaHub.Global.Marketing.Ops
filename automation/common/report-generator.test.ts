import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateReport, writeReportAtomic } from "./report-generator.js";
import type { OperationalSummary, PlatformStatus, BrandProfile } from "./types.js";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "report-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSummary(overrides: Partial<OperationalSummary> = {}): OperationalSummary {
  return {
    brand: "Best Fluency",
    market: "PT",
    locale: "pt-PT",
    totalPlatforms: 9,
    enabled: 8,
    pending: 7,
    manualRequired: 0,
    inProgress: 1,
    submitted: 0,
    verificationRequired: 0,
    verified: 0,
    rejected: 0,
    disabled: 1,
    dataQualityAlerts: [],
    ...overrides,
  };
}

function makeBrandProfile(): BrandProfile {
  return {
    id: "best-fluency",
    name: "Best Fluency",
    website: "https://bestfluency.pt",
  };
}

function makeStatuses(): PlatformStatus[] {
  return [
    {
      platform: {
        id: "google-business-profile",
        name: "Google Business Profile",
        country: "GLOBAL",
        locale: null,
        url: "https://business.google.com/",
        registrationType: "form",
        automationMode: "manual",
        requiresLogin: true,
        requiresCaptcha: null,
        requiresEmailVerification: null,
        requiresPhoneVerification: null,
        enabled: true,
      },
      listing: {
        platform_id: "google-business-profile",
        listing_name: "Fluency",
        enabled: true,
        priority: "critical",
        status: "in_progress",
      },
      status: "in_progress",
      source: "global",
      issues: [],
    },
    {
      platform: {
        id: "bing-for-business",
        name: "Bing Places for Business",
        country: "GLOBAL",
        locale: null,
        url: "https://www.bing.com/forbusiness",
        registrationType: "form",
        automationMode: "manual",
        requiresLogin: true,
        requiresCaptcha: null,
        requiresEmailVerification: null,
        requiresPhoneVerification: null,
        enabled: true,
      },
      listing: {
        platform_id: "bing-for-business",
        enabled: true,
        priority: "critical",
        status: "pending",
      },
      status: "pending",
      source: "global",
      issues: [],
    },
  ];
}

describe("report-generator", () => {
  describe("generateReport", () => {
    it("generates a report with correct header", () => {
      const report = generateReport(
        makeSummary(),
        makeStatuses(),
        makeBrandProfile(),
        "2026-01-01",
      );
      expect(report).toContain("# Best Fluency — Marketing Ops — PT");
      expect(report).toContain("Generated at: 2026-01-01");
    });

    it("includes summary stats", () => {
      const report = generateReport(makeSummary(), makeStatuses(), makeBrandProfile());
      expect(report).toContain("Total platforms: 9");
      expect(report).toContain("Enabled: 8");
      expect(report).toContain("Pending: 7");
      expect(report).toContain("In progress: 1");
      expect(report).toContain("Disabled: 1");
    });

    it("includes operational queue table", () => {
      const report = generateReport(makeSummary(), makeStatuses(), makeBrandProfile());
      expect(report).toContain("## Operational Queue");
      expect(report).toContain(
        "| Priority | Platform | Listing Name | Category | Status | Listing URL | Next Action |",
      );
      expect(report).toContain("Google Business Profile");
      expect(report).toContain("Bing Places for Business");
    });

    it("sorts by priority in operational queue", () => {
      const report = generateReport(makeSummary(), makeStatuses(), makeBrandProfile());
      const bpIndex = report.indexOf("Bing Places");
      const gpIndex = report.indexOf("Google Business");
      expect(bpIndex).toBeLessThan(gpIndex);
    });

    it("includes listing name in table", () => {
      const report = generateReport(makeSummary(), makeStatuses(), makeBrandProfile());
      expect(report).toContain("Fluency");
    });

    it("shows data quality section with no alerts", () => {
      const report = generateReport(makeSummary(), makeStatuses(), makeBrandProfile());
      expect(report).toContain("## Data Quality");
      expect(report).toContain("No data quality issues detected.");
    });

    it("shows data quality alerts when present", () => {
      const summary = makeSummary({
        dataQualityAlerts: ["missing business phone", "missing email"],
      });
      const report = generateReport(summary, makeStatuses(), makeBrandProfile());
      expect(report).toContain("missing business phone");
      expect(report).toContain("missing email");
    });

    it("escapes pipe characters in table cells", () => {
      const statuses = makeStatuses();
      statuses[0].listing!.listing_name = "Test | Pipe";
      const report = generateReport(makeSummary(), statuses, makeBrandProfile());
      expect(report).toContain("Test \\| Pipe");
    });

    it("escapes backslash, backticks, and HTML-like content", () => {
      const statuses = makeStatuses();
      statuses[0].listing!.listing_name = 'Test \\ ` <script>alert("xss")</script>';
      const report = generateReport(makeSummary(), statuses, makeBrandProfile());
      expect(report).toContain('Test \\\\ \\` &lt;script&gt;alert("xss")&lt;/script&gt;');
    });

    it("shows N/A for disabled platforms", () => {
      const statuses = makeStatuses();
      statuses[1].status = "disabled";
      statuses[1].listing!.enabled = false;
      const report = generateReport(makeSummary(), statuses, makeBrandProfile());
      expect(report).toContain("| N/A |");
    });

    it("shows correct next actions per status", () => {
      const testCases: Array<{ status: PlatformStatus["status"]; expected: string }> = [
        { status: "pending", expected: "Register on platform" },
        { status: "manual_required", expected: "Complete manual registration" },
        { status: "in_progress", expected: "Complete/confirm update" },
        { status: "submitted", expected: "Await verification" },
        { status: "verification_required", expected: "Verify listing" },
        { status: "verified", expected: "No action needed" },
        { status: "rejected", expected: "Re-register" },
      ];

      for (const tc of testCases) {
        const statuses = makeStatuses();
        statuses[0].status = tc.status;
        const report = generateReport(makeSummary(), statuses, makeBrandProfile());
        expect(report).toContain(tc.expected);
      }
    });
  });

  describe("writeReportAtomic", () => {
    it("writes report file atomically", () => {
      const reportsDir = join(tempDir, "reports");
      mkdirSync(reportsDir, { recursive: true });
      const path = writeReportAtomic("# Test Report", reportsDir, "best-fluency", "PT");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("# Test Report");
    });

    it("creates parent directories", () => {
      const reportsDir = join(tempDir, "deep", "reports");
      const path = writeReportAtomic("# Test", reportsDir, "best-fluency", "PT");
      expect(existsSync(path)).toBe(true);
    });

    it("cleans up temp file on error", () => {
      const reportsDir = join(tempDir, "reports");
      mkdirSync(reportsDir, { recursive: true });
      const path = writeReportAtomic("# Test", reportsDir, "best-fluency", "PT");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(path + ".tmp")).toBe(false);
    });
  });
});
