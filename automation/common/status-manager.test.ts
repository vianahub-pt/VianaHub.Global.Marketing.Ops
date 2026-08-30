import { describe, it, expect } from "vitest";
import { buildStatus, buildSummary, sortByPriority } from "./status-manager.js";
import type { PlatformWithSource, ListingEntry, BrandProfile, ListingStatus } from "./types.js";

const mockBrandProfile: BrandProfile = {
  id: "test-brand",
  name: "Test Brand",
  website: "https://test.com",
};

function createPlatform(overrides: Partial<PlatformWithSource> & { id: string }): PlatformWithSource {
  return {
    name: overrides.id,
    country: "PT",
    locale: "pt-PT",
    url: `https://${overrides.id}.com`,
    registrationType: "form",
    automationMode: "semi-automatic",
    requiresLogin: false,
    requiresCaptcha: false,
    requiresEmailVerification: false,
    requiresPhoneVerification: false,
    enabled: true,
    source: "global",
    ...overrides,
  };
}

describe("buildStatus", () => {
  it("identifies platform with listing", () => {
    const platforms = [createPlatform({ id: "platform-a", source: "global" })];
    const listings: ListingEntry[] = [
      { platform_id: "platform-a", enabled: true, priority: "high", status: "verified", listing_url: "https://a.com/listing" },
    ];

    const statuses = buildStatus(platforms, listings);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("verified");
    expect(statuses[0].source).toBe("global");
  });

  it("identifies platform without listing as pending", () => {
    const platforms = [createPlatform({ id: "platform-a", source: "market" })];
    const listings: ListingEntry[] = [];

    const statuses = buildStatus(platforms, listings);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("pending");
    expect(statuses[0].source).toBe("market");
  });

  it("identifies listing referencing unknown platform", () => {
    const platforms = [createPlatform({ id: "known-platform" })];
    const listings: ListingEntry[] = [
      { platform_id: "unknown-platform", enabled: true, priority: "low", status: "pending" },
    ];

    const statuses = buildStatus(platforms, listings);
    expect(statuses).toHaveLength(2);
    const unknown = statuses.find((s) => s.platform.id === "unknown-platform");
    expect(unknown).toBeDefined();
    expect(unknown!.issues.length).toBeGreaterThan(0);
    expect(unknown!.source).toBe("market");
  });

  it("propagates source correctly from global", () => {
    const platforms = [createPlatform({ id: "p1", source: "global" })];
    const statuses = buildStatus(platforms, []);
    expect(statuses[0].source).toBe("global");
  });

  it("propagates source correctly from market", () => {
    const platforms = [createPlatform({ id: "p1", source: "market" })];
    const statuses = buildStatus(platforms, []);
    expect(statuses[0].source).toBe("market");
  });
});

describe("buildStatus - all ListingStatus values", () => {
  const allStatuses: ListingStatus[] = [
    "pending",
    "manual_required",
    "in_progress",
    "submitted",
    "verification_required",
    "verified",
    "rejected",
    "disabled",
  ];

  for (const statusValue of allStatuses) {
    it(`handles status: ${statusValue}`, () => {
      const platforms = [createPlatform({ id: `p-${statusValue}` })];
      const listings: ListingEntry[] = [
        { platform_id: `p-${statusValue}`, enabled: true, priority: "medium", status: statusValue },
      ];

      const statuses = buildStatus(platforms, listings);
      expect(statuses[0].status).toBe(statusValue);
    });
  }

  it("handles disabled platform", () => {
    const platforms = [createPlatform({ id: "disabled-p", enabled: false })];
    const listings: ListingEntry[] = [
      { platform_id: "disabled-p", enabled: true, priority: "medium", status: "pending" },
    ];

    const statuses = buildStatus(platforms, listings);
    expect(statuses[0].status).toBe("disabled");
  });

  it("handles disabled listing", () => {
    const platforms = [createPlatform({ id: "disabled-l" })];
    const listings: ListingEntry[] = [
      { platform_id: "disabled-l", enabled: false, priority: "medium", status: "pending" },
    ];

    const statuses = buildStatus(platforms, listings);
    expect(statuses[0].status).toBe("disabled");
  });
});

describe("buildSummary", () => {
  it("calculates summary correctly", () => {
    const platforms = [
      createPlatform({ id: "p1", source: "global" }),
      createPlatform({ id: "p2", source: "market" }),
    ];
    const listings: ListingEntry[] = [
      { platform_id: "p1", enabled: true, priority: "high", status: "verified" },
    ];

    const statuses = buildStatus(platforms, listings);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", mockBrandProfile);

    expect(summary.totalPlatforms).toBe(2);
    expect(summary.verified).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.manualRequired).toBe(0);
  });

  it("counts manual_required status", () => {
    const platforms = [
      createPlatform({ id: "p1" }),
      createPlatform({ id: "p2" }),
      createPlatform({ id: "p3" }),
    ];
    const listings: ListingEntry[] = [
      { platform_id: "p1", enabled: true, priority: "high", status: "manual_required" },
      { platform_id: "p2", enabled: true, priority: "high", status: "manual_required" },
      { platform_id: "p3", enabled: true, priority: "high", status: "verified" },
    ];

    const statuses = buildStatus(platforms, listings);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", mockBrandProfile);

    expect(summary.manualRequired).toBe(2);
    expect(summary.verified).toBe(1);
  });

  it("detects missing data quality alerts", () => {
    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", mockBrandProfile);

    expect(summary.dataQualityAlerts).toContain("missing business phone");
    expect(summary.dataQualityAlerts).toContain("missing email");
    expect(summary.dataQualityAlerts).toContain("incomplete address");
  });

  it("no data quality alerts when profile is complete", () => {
    const completeProfile: BrandProfile = {
      id: "complete",
      name: "Complete",
      website: "https://complete.com",
      phone: "+351123456789",
      email: "info@complete.com",
      address: { street: "Rua Test", city: "Lisboa", country: "PT" },
    };

    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", completeProfile);

    expect(summary.dataQualityAlerts).toHaveLength(0);
  });

  it("only shows missing email when phone and address are present", () => {
    const profileWithPhone: BrandProfile = {
      id: "partial",
      name: "Partial",
      website: "https://partial.com",
      phone: "+351123456789",
      address: { street: "Rua Test", city: "Lisboa", country: "PT" },
    };

    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", profileWithPhone);

    expect(summary.dataQualityAlerts).toContain("missing email");
    expect(summary.dataQualityAlerts).not.toContain("missing business phone");
    expect(summary.dataQualityAlerts).not.toContain("incomplete address");
  });

  it("incomplete address requires both street and city", () => {
    const profileNoStreet: BrandProfile = {
      id: "no-street",
      name: "No Street",
      website: "https://no-street.com",
      phone: "+351123456789",
      address: { city: "Lisboa", country: "PT" },
    };

    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", profileNoStreet);

    expect(summary.dataQualityAlerts).toContain("incomplete address");

    const profileNoCity: BrandProfile = {
      id: "no-city",
      name: "No City",
      website: "https://no-city.com",
      phone: "+351123456789",
      address: { street: "Rua Test", country: "PT" },
    };

    const summary2 = buildSummary(statuses, "Test Brand", "PT", "pt-PT", profileNoCity);
    expect(summary2.dataQualityAlerts).toContain("incomplete address");
  });

  it("address without postalCode is considered complete", () => {
    const profileNoPostal: BrandProfile = {
      id: "no-postal",
      name: "No Postal",
      website: "https://no-postal.com",
      phone: "+351123456789",
      email: "info@no-postal.com",
      address: { street: "Rua Test", city: "Lisboa", district: "Lisboa", country: "PT" },
    };

    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Test Brand", "PT", "pt-PT", profileNoPostal);

    expect(summary.dataQualityAlerts).toHaveLength(0);
  });
});

describe("sortByPriority", () => {
  it("sorts by priority then alphabetically", () => {
    const platforms = [
      createPlatform({ id: "platform-c" }),
      createPlatform({ id: "platform-a" }),
      createPlatform({ id: "platform-b" }),
    ];
    const listings: ListingEntry[] = [
      { platform_id: "platform-c", enabled: true, priority: "low", status: "pending" },
      { platform_id: "platform-a", enabled: true, priority: "critical", status: "pending" },
      { platform_id: "platform-b", enabled: true, priority: "high", status: "pending" },
    ];

    const statuses = buildStatus(platforms, listings);
    const sorted = sortByPriority(statuses);

    expect(sorted[0].platform.id).toBe("platform-a");
    expect(sorted[1].platform.id).toBe("platform-b");
    expect(sorted[2].platform.id).toBe("platform-c");
  });

  it("handles platforms without listings", () => {
    const platforms = [
      createPlatform({ id: "platform-b" }),
      createPlatform({ id: "platform-a" }),
    ];

    const statuses = buildStatus(platforms, []);
    const sorted = sortByPriority(statuses);

    expect(sorted[0].platform.id).toBe("platform-a");
    expect(sorted[1].platform.id).toBe("platform-b");
  });
});

describe("BrandProfile - new fields", () => {
  it("supports languagesTaught", () => {
    const profile: BrandProfile = {
      id: "test",
      name: "Test",
      website: "https://test.com",
      languagesTaught: ["English", "Spanish", "French", "Portuguese"],
    };

    expect(profile.languagesTaught).toHaveLength(4);
    expect(profile.languagesTaught).toContain("English");
  });

  it("supports supportedLocales", () => {
    const profile: BrandProfile = {
      id: "test",
      name: "Test",
      website: "https://test.com",
      supportedLocales: ["pt-PT", "en-US", "es-ES"],
    };

    expect(profile.supportedLocales).toHaveLength(3);
    expect(profile.supportedLocales).toContain("pt-PT");
  });

  it("languagesTaught and supportedLocales are independent", () => {
    const profile: BrandProfile = {
      id: "test",
      name: "Test",
      website: "https://test.com",
      languagesTaught: ["English"],
      supportedLocales: ["pt-PT", "en-US", "ja-JP", "zh-CN"],
    };

    expect(profile.languagesTaught).toHaveLength(1);
    expect(profile.supportedLocales).toHaveLength(4);
  });

  it("supports structured businessHours", () => {
    const profile: BrandProfile = {
      id: "test",
      name: "Test",
      website: "https://test.com",
      businessHours: {
        monday: { closed: false, open: "08:00", close: "21:00" },
        tuesday: { closed: false, open: "08:00", close: "21:00" },
        wednesday: { closed: false, open: "08:00", close: "21:00" },
        thursday: { closed: false, open: "08:00", close: "21:00" },
        friday: { closed: false, open: "08:00", close: "17:00" },
        saturday: { closed: true },
        sunday: { closed: true },
      },
    };

    expect(profile.businessHours?.monday.closed).toBe(false);
    expect(profile.businessHours?.monday.open).toBe("08:00");
    expect(profile.businessHours?.monday.close).toBe("21:00");
    expect(profile.businessHours?.saturday.closed).toBe(true);
    expect(profile.businessHours?.saturday.open).toBeUndefined();
  });

  it("no data quality alerts with complete Best Fluency profile", () => {
    const bestFluencyProfile: BrandProfile = {
      id: "best-fluency",
      name: "Best Fluency",
      website: "https://bestfluency.pt",
      email: "vianahub.pt@gmail.com",
      phone: "+351 21 474 4028",
      address: {
        street: "Avenida Chaby Pinheiro, 5",
        city: "Amadora",
        postalCode: "2700-301",
        district: "Lisboa",
        country: "PT",
      },
    };

    const platforms = [createPlatform({ id: "p1" })];
    const statuses = buildStatus(platforms, []);
    const summary = buildSummary(statuses, "Best Fluency", "PT", "pt-PT", bestFluencyProfile);

    expect(summary.dataQualityAlerts).toHaveLength(0);
  });
});
