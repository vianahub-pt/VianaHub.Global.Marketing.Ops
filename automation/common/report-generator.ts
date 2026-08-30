import type {
  OperationalSummary,
  PlatformStatus,
  BrandProfile,
  ListingPriority,
} from "./types.js";

const PRIORITY_ORDER: Record<ListingPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function generateReport(
  summary: OperationalSummary,
  statuses: PlatformStatus[],
  brandProfile: BrandProfile,
): string {
  const lines: string[] = [];

  lines.push(`# ${summary.brand} — Marketing Ops — ${summary.market}`);
  lines.push("");
  lines.push(`Generated at: ${new Date().toISOString()}`);
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
  lines.push("| Priority | Platform | Listing Name | Category | Status | Listing URL | Next Action |");
  lines.push("|----------|----------|--------------|----------|--------|-------------|-------------|");

  const sorted = [...statuses].sort((a, b) => {
    const aP = a.listing ? PRIORITY_ORDER[a.listing.priority] : 4;
    const bP = b.listing ? PRIORITY_ORDER[b.listing.priority] : 4;
    if (aP !== bP) return aP - bP;
    return a.platform.name.localeCompare(b.platform.name);
  });

  for (const s of sorted) {
    const priority = s.listing?.priority ?? "low";
    const listingName = s.listing?.listing_name ?? "—";
    const category = s.platform.category ?? "other";
    const url = s.listing?.listing_url ?? "—";
    const nextAction = getNextAction(s);
    lines.push(
      `| ${priority} | ${s.platform.name} | ${listingName} | ${category} | ${s.status} | ${url} | ${nextAction} |`,
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
      lines.push(`- ⚠ ${alert}`);
    }
  }

  lines.push("");

  return lines.join("\n");
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
