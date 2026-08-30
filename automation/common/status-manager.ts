import type {
  PlatformDefinition,
  ListingEntry,
  PlatformStatus,
  OperationalSummary,
  ListingStatus,
  ListingPriority,
  BrandProfile,
} from "./types.js";

const PRIORITY_ORDER: Record<ListingPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function buildStatus(
  platforms: PlatformDefinition[],
  listings: ListingEntry[],
): PlatformStatus[] {
  const listingMap = new Map<string, ListingEntry>();
  for (const l of listings) {
    listingMap.set(l.platform_id, l);
  }

  const platformIds = new Set(platforms.map((p) => p.id));
  const statuses: PlatformStatus[] = [];

  // Platforms known → check if listing exists
  for (const platform of platforms) {
    const listing = listingMap.get(platform.id) ?? null;
    const issues: string[] = [];

    let status: ListingStatus;
    if (!listing) {
      status = "pending";
      issues.push("No listing configured");
    } else if (!platform.enabled) {
      status = "disabled";
    } else if (!listing.enabled) {
      status = "disabled";
    } else {
      status = listing.status;
    }

    if (listing?.listing_url) {
      // Has URL, good
    } else if (status === "verified" || status === "submitted") {
      issues.push("Missing listing URL");
    }

    statuses.push({ platform, listing, status, source: "global", issues });
  }

  // Listings referencing unknown platforms
  for (const listing of listings) {
    if (!platformIds.has(listing.platform_id)) {
      statuses.push({
        platform: {
          id: listing.platform_id,
          name: listing.platform_id,
          country: "",
          locale: null,
          url: "",
          registrationType: "manual",
          automationMode: "manual",
          requiresLogin: false,
          requiresCaptcha: false,
          requiresEmailVerification: false,
          requiresPhoneVerification: false,
          enabled: false,
        },
        listing,
        status: "pending",
        source: "global",
        issues: [`Listing references unknown platform "${listing.platform_id}"`],
      });
    }
  }

  return statuses;
}

export function buildSummary(
  statuses: PlatformStatus[],
  brand: string,
  market: string,
  locale: string,
  brandProfile: BrandProfile,
): OperationalSummary {
  const dataQualityAlerts: string[] = [];

  if (!brandProfile.phone) {
    dataQualityAlerts.push("missing business phone");
  }
  if (!brandProfile.email) {
    dataQualityAlerts.push("missing email");
  }
  if (!brandProfile.address || !brandProfile.address.street || !brandProfile.address.city) {
    dataQualityAlerts.push("incomplete address");
  }

  const counts: Record<string, number> = {
    pending: 0,
    in_progress: 0,
    submitted: 0,
    verification_required: 0,
    verified: 0,
    rejected: 0,
    disabled: 0,
  };

  for (const s of statuses) {
    if (s.status in counts) {
      counts[s.status]++;
    }
  }

  return {
    brand,
    market,
    locale,
    totalPlatforms: statuses.length,
    enabled: statuses.filter((s) => s.status !== "disabled").length,
    pending: counts.pending,
    inProgress: counts.in_progress,
    submitted: counts.submitted,
    verificationRequired: counts.verification_required,
    verified: counts.verified,
    rejected: counts.rejected,
    disabled: counts.disabled,
    dataQualityAlerts,
  };
}

export function sortByPriority(statuses: PlatformStatus[]): PlatformStatus[] {
  return [...statuses].sort((a, b) => {
    const aPriority = a.listing ? PRIORITY_ORDER[a.listing.priority] : 4;
    const bPriority = b.listing ? PRIORITY_ORDER[b.listing.priority] : 4;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.platform.name.localeCompare(b.platform.name);
  });
}
