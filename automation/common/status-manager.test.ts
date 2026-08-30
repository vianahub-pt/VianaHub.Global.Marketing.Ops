import { describe, it, expect } from "vitest";
import { buildStatus, buildSummary, sortByPriority } from "./status-manager.js";
import type { PlatformDefinition, ListingEntry, BrandProfile } from "./types.js";

const mockBrandProfile: BrandProfile = {
  id: "test-brand",
  name: "Test Brand",
  website: "https://test.com",
};

const mockPlatforms: PlatformDefinition[] = [
  {
    id: "platform-a",
    name: "Platform A",
    country: "PT",
    locale: "pt-PT",
    url: "https://a.com",
    registrationType: "form",
    automationMode: "semi-automatic",
    requiresLogin: true,
    requiresCaptcha: false,
    requiresEmailVerification: false,
    requiresPhoneVerification: false,
    enabled: true,
  },
  {
    id: "platform-b",
    name: "Platform B",
    country: "PT",
    locale: "pt-PT",
    url: "https://b.com",
    registrationType: "form",
    automationMode: "manual",
    requiresLogin: false,
    requiresCaptcha: false,
    requiresEmailVerification: false,
    requiresPhoneVerification: false,
    enabled: true,
  },
];

const mockListings: ListingEntry[] = [
  {
    platform_id: "platform-a",
    enabled: true,
    priority: "high",
    status: "verified",
    listing_url: "https://a.com/listing/123",
  },
];

describe("buildStatus", () => {
  it("identifies platform with listing", () => {
    const statuses = buildStatus(mockPlatforms, mockListings);
    const platformA = statuses.find((s) => s.platform.id === "platform-a");
    expect(platformA).toBeDefined();
    expect(platformA!.status).toBe("verified");
    expect(platformA!.listing).not.toBeNull();
  });

  it("identifies platform without listing as pending", () => {
    const statuses = buildStatus(mockPlatforms, mockListings);
    const platformB = statuses.find((s) => s.platform.id === "platform-b");
    expect(platformB).toBeDefined();
    expect(platformB!.status).toBe("pending");
  });

  it("identifies listing referencing unknown platform", () => {
    const badListing: ListingEntry[] = [
      {
        platform_id: "unknown-platform",
        enabled: true,
        priority: "low",
        status: "pending",
      },
    ];
    const statuses = buildStatus(mockPlatforms, badListing);
    const unknown = statuses.find((s) => s.platform.id === "unknown-platform");
    expect(unknown).toBeDefined();
    expect(unknown!.issues.length).toBeGreaterThan(0);
  });
});

describe("buildSummary", () => {
  it("calculates summary correctly", () => {
    const statuses = buildStatus(mockPlatforms, mockListings);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", mockBrandProfile);
    expect(summary.totalPlatforms).toBe(2);
    expect(summary.verified).toBe(1);
  });

  it("detects missing data quality alerts", () => {
    const statuses = buildStatus(mockPlatforms, mockListings);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", mockBrandProfile);
    expect(summary.dataQualityAlerts).toContain("missing business phone");
    expect(summary.dataQualityAlerts).toContain("missing email");
  });
});

describe("sortByPriority", () => {
  it("sorts by priority then alphabetically", () => {
    const listings: ListingEntry[] = [
      { platform_id: "platform-b", enabled: true, priority: "low", status: "pending" },
      { platform_id: "platform-a", enabled: true, priority: "critical", status: "pending" },
    ];
    const statuses = buildStatus(mockPlatforms, listings);
    const sorted = sortByPriority(statuses);
    expect(sorted[0].platform.id).toBe("platform-a");
    expect(sorted[1].platform.id).toBe("platform-b");
  });
});
