import { describe, it, expect } from "vitest";
import {
  BrandProfileSchema,
  TargetsFileSchema,
  PlatformDefinitionSchema,
  ListingEntrySchema,
  validateListing,
} from "./schemas.js";

describe("schemas", () => {
  describe("BrandProfileSchema", () => {
    it("validates a valid brand profile", () => {
      const data = {
        id: "best-fluency",
        name: "Best Fluency",
        website: "https://bestfluency.pt",
      };
      expect(() => BrandProfileSchema.parse(data)).not.toThrow();
    });

    it("rejects brand profile with invalid id format", () => {
      const data = {
        id: "Best Fluency",
        name: "Best Fluency",
        website: "https://bestfluency.pt",
      };
      expect(() => BrandProfileSchema.parse(data)).toThrow();
    });

    it("rejects brand profile with invalid website", () => {
      const data = {
        id: "best-fluency",
        name: "Best Fluency",
        website: "not-a-url",
      };
      expect(() => BrandProfileSchema.parse(data)).toThrow();
    });

    it("accepts brand profile with optional fields", () => {
      const data = {
        id: "best-fluency",
        name: "Best Fluency",
        website: "https://bestfluency.pt",
        email: "info@bestfluency.pt",
        phone: "+351123456789",
        address: { street: "Rua Test", city: "Lisboa", country: "PT" },
      };
      expect(() => BrandProfileSchema.parse(data)).not.toThrow();
    });

    it("rejects unknown fields (strict mode)", () => {
      const data = {
        id: "best-fluency",
        name: "Best Fluency",
        website: "https://bestfluency.pt",
        unknownField: "test",
      };
      expect(() => BrandProfileSchema.parse(data)).toThrow();
    });
  });

  describe("TargetsFileSchema", () => {
    it("validates a valid targets file", () => {
      const data = {
        brandId: "best-fluency",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
      };
      expect(() => TargetsFileSchema.parse(data)).not.toThrow();
    });

    it("rejects duplicate market countries", () => {
      const data = {
        brandId: "best-fluency",
        markets: [
          { country: "PT", locale: "pt-PT", enabled: true, priority: "primary" },
          { country: "PT", locale: "pt-BR", enabled: false, priority: "secondary" },
        ],
      };
      expect(() => TargetsFileSchema.parse(data)).toThrow(/Duplicate market countries/);
    });

    it("rejects invalid country code", () => {
      const data = {
        brandId: "best-fluency",
        markets: [{ country: "Portugal", locale: "pt-PT", enabled: true, priority: "primary" }],
      };
      expect(() => TargetsFileSchema.parse(data)).toThrow();
    });

    it("rejects invalid locale format", () => {
      const data = {
        brandId: "best-fluency",
        markets: [{ country: "PT", locale: "pt", enabled: true, priority: "primary" }],
      };
      expect(() => TargetsFileSchema.parse(data)).toThrow();
    });

    it("rejects invalid priority", () => {
      const data = {
        brandId: "best-fluency",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "urgent" }],
      };
      expect(() => TargetsFileSchema.parse(data)).toThrow();
    });

    it("rejects unknown fields (strict mode)", () => {
      const data = {
        brandId: "best-fluency",
        markets: [{ country: "PT", locale: "pt-PT", enabled: true, priority: "primary" }],
        unknownField: "test",
      };
      expect(() => TargetsFileSchema.parse(data)).toThrow();
    });
  });

  describe("PlatformDefinitionSchema", () => {
    it("validates a valid platform definition", () => {
      const data = {
        id: "google-business-profile",
        name: "Google Business Profile",
        country: "GLOBAL",
        url: "https://business.google.com/",
        registrationType: "form",
        automationMode: "manual",
        requiresLogin: true,
        requiresCaptcha: null,
        requiresEmailVerification: null,
        requiresPhoneVerification: null,
        pricingModel: "free",
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).not.toThrow();
    });

    it("validates platform with GLOBAL country", () => {
      const data = {
        id: "test",
        name: "Test",
        country: "GLOBAL",
        url: "https://test.com",
        registrationType: "form",
        automationMode: "manual",
        requiresLogin: false,
        requiresCaptcha: false,
        requiresEmailVerification: false,
        requiresPhoneVerification: false,
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).not.toThrow();
    });

    it("validates platform with 2-letter country code", () => {
      const data = {
        id: "test",
        name: "Test",
        country: "PT",
        url: "https://test.com",
        registrationType: "form",
        automationMode: "manual",
        requiresLogin: false,
        requiresCaptcha: false,
        requiresEmailVerification: false,
        requiresPhoneVerification: false,
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).not.toThrow();
    });

    it("rejects automatic platform with requiresLogin true", () => {
      const data = {
        id: "test",
        name: "Test",
        country: "PT",
        url: "https://test.com",
        registrationType: "api",
        automationMode: "automatic",
        requiresLogin: true,
        requiresCaptcha: false,
        requiresEmailVerification: false,
        requiresPhoneVerification: false,
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).toThrow(/Automatic platforms/);
    });

    it("accepts automatic platform with all requires as false", () => {
      const data = {
        id: "test",
        name: "Test",
        country: "PT",
        url: "https://test.com",
        registrationType: "api",
        automationMode: "automatic",
        requiresLogin: false,
        requiresCaptcha: false,
        requiresEmailVerification: false,
        requiresPhoneVerification: false,
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).not.toThrow();
    });

    it("accepts semi-automatic platform with requiresLogin true", () => {
      const data = {
        id: "test",
        name: "Test",
        country: "PT",
        url: "https://test.com",
        registrationType: "form",
        automationMode: "semi-automatic",
        requiresLogin: true,
        requiresCaptcha: null,
        requiresEmailVerification: null,
        requiresPhoneVerification: null,
        enabled: true,
      };
      expect(() => PlatformDefinitionSchema.parse(data)).not.toThrow();
    });
  });

  describe("ListingEntrySchema", () => {
    it("validates a valid listing entry", () => {
      const data = {
        platform_id: "google-business-profile",
        enabled: "true",
        priority: "critical",
        status: "in_progress",
      };
      expect(() => ListingEntrySchema.parse(data)).not.toThrow();
    });

    it("validates listing with all optional fields", () => {
      const data = {
        platform_id: "google-business-profile",
        listing_name: "Fluency",
        enabled: "true",
        priority: "critical",
        status: "in_progress",
        listing_url: "https://business.google.com/listing/123",
        last_checked: "2026-08-30",
        notes: "Test notes",
      };
      expect(() => ListingEntrySchema.parse(data)).not.toThrow();
    });

    it("rejects invalid enabled value", () => {
      const data = {
        platform_id: "test",
        enabled: "yes",
        priority: "high",
        status: "pending",
      };
      expect(() => ListingEntrySchema.parse(data)).toThrow();
    });

    it("rejects invalid priority", () => {
      const data = {
        platform_id: "test",
        enabled: "true",
        priority: "urgent",
        status: "pending",
      };
      expect(() => ListingEntrySchema.parse(data)).toThrow();
    });

    it("rejects invalid status", () => {
      const data = {
        platform_id: "test",
        enabled: "true",
        priority: "high",
        status: "unknown",
      };
      expect(() => ListingEntrySchema.parse(data)).toThrow();
    });

    it("rejects invalid last_checked format", () => {
      const data = {
        platform_id: "test",
        enabled: "true",
        priority: "high",
        status: "pending",
        last_checked: "30-08-2026",
      };
      expect(() => ListingEntrySchema.parse(data)).toThrow();
    });
  });

  describe("validateListing", () => {
    it("converts enabled string to boolean", () => {
      const result = validateListing({
        platform_id: "test",
        enabled: "true",
        priority: "high",
        status: "pending",
      });
      expect(result.enabled).toBe(true);
      expect(typeof result.enabled).toBe("boolean");
    });

    it("converts enabled false string to boolean", () => {
      const result = validateListing({
        platform_id: "test",
        enabled: "false",
        priority: "high",
        status: "pending",
      });
      expect(result.enabled).toBe(false);
    });

    it("throws on invalid listing", () => {
      expect(() =>
        validateListing({
          platform_id: "test",
          enabled: "invalid",
          priority: "high",
          status: "pending",
        }),
      ).toThrow(/Invalid listing/);
    });
  });
});
