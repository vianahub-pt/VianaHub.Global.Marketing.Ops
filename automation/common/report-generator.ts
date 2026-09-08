import { writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OperationalSummary, PlatformStatus, BrandProfile, ListingPriority } from "./types.js";
import { safeResolve } from "./path-security.js";

const PRIORITY_ORDER: Record<ListingPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\n/g, " ");
}

export function generateReport(
  summary: OperationalSummary,
  statuses: PlatformStatus[],
  brandProfile: BrandProfile,
  generatedAt?: string,
): string {
  const lines: string[] = [];
  const timestamp = generatedAt ?? new Date().toISOString();

  lines.push(`# ${summary.brand} — Marketing Ops — ${summary.market}`);
  lines.push("");
  lines.push(`Generated at: ${timestamp}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`Total platforms: ${summary.totalPlatforms}`);
  lines.push(`Enabled: ${summary.enabled}`);
  lines.push(`Pending: ${summary.pending}`);
  lines.push(`Manual required: ${summary.manualRequired}`);
  lines.push(`In progress: ${summary.inProgress}`);
  lines.push(`Submitted: ${summary.submitted}`);
  lines.push(`Verification required: ${summary.verificationRequired}`);
  lines.push(`Verified: ${summary.verified}`);
  lines.push(`Rejected: ${summary.rejected}`);
  lines.push(`Disabled: ${summary.disabled}`);
  lines.push("");

  // Operational Queue
  lines.push("## Operational Queue");
  lines.push("");
  lines.push(
    "| Priority | Platform | Listing Name | Category | Status | Listing URL | Next Action |",
  );
  lines.push(
    "|----------|----------|--------------|----------|--------|-------------|-------------|",
  );

  const sorted = [...statuses].sort((a, b) => {
    const aP = a.listing ? PRIORITY_ORDER[a.listing.priority] : 4;
    const bP = b.listing ? PRIORITY_ORDER[b.listing.priority] : 4;
    if (aP !== bP) {
      return aP - bP;
    }
    return a.platform.name.localeCompare(b.platform.name);
  });

  for (const s of sorted) {
    const priority = s.listing?.priority ?? "low";
    const listingName = escapeMarkdownCell(s.listing?.listing_name ?? "—");
    const category = s.platform.category ?? "other";
    const url = s.listing?.listing_url ?? "—";
    const nextAction = getNextAction(s);
    lines.push(
      `| ${priority} | ${escapeMarkdownCell(s.platform.name)} | ${listingName} | ${category} | ${s.status} | ${escapeMarkdownCell(url)} | ${escapeMarkdownCell(nextAction)} |`,
    );
  }

  lines.push("");

  // Data Quality
  lines.push("## Data Quality");
  lines.push("");
  if (summary.dataQualityAlerts.length === 0) {
    lines.push("No data quality issues detected.");
  } else {
    for (const alert of summary.dataQualityAlerts) {
      lines.push(`- ⚠ ${escapeMarkdownCell(alert)}`);
    }
  }

  lines.push("");

  return lines.join("\n");
}

export function writeReportAtomic(
  content: string,
  reportsDir: string,
  brand: string,
  market: string,
): string {
  // Validate path stays inside reports directory
  const targetDir = safeResolve(reportsDir, brand, market);
  const targetPath = resolve(targetDir, "README.md");

  mkdirSync(targetDir, { recursive: true });

  const tmpPath = targetPath + ".tmp";

  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Cleanup temp file on error
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  }

  return targetPath;
}

function getNextAction(status: PlatformStatus): string {
  if (status.issues.length > 0) {
    return status.issues[0];
  }

  switch (status.status) {
    case "pending":
      return "Register on platform";
    case "manual_required":
      return "Complete manual registration";
    case "in_progress":
      return "Complete/confirm update";
    case "submitted":
      return "Await verification";
    case "verification_required":
      return "Verify listing";
    case "verified":
      return "No action needed";
    case "rejected":
      return "Re-register";
    case "disabled":
      return "N/A";
    default:
      return "Review";
  }
}
