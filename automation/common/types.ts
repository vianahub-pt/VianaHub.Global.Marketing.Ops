/**
 * Base adapter interface for platform integrations.
 *
 * Each platform adapter implements this interface so that
 * automation workflows remain brand-agnostic.
 *
 * The adapter receives three dimensions of configuration:
 * - brand: which company's data to use
 * - market: which country/region to target
 * - platform: which external platform to interact with
 */

export interface AdapterConfig {
  brand: string;
  market: string;
  platform: string;
}

export interface RegistrationResult {
  success: boolean;
  listingUrl?: string;
  error?: string;
  requiresManualAction?: boolean;
}

export interface PlatformAdapter {
  readonly platformId: string;

  /**
   * Prepare the adapter with brand, market, and platform configuration.
   *
   * Example:
   *   configure({ brand: "best-fluency", market: "PT", platform: "cylex-pt" })
   */
  configure(config: AdapterConfig): Promise<void>;

  /**
   * Check if the platform is accessible and ready.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Execute the registration or update flow.
   * Returns a result indicating success, failure, or need for manual action.
   */
  register(): Promise<RegistrationResult>;

  /**
   * Clean up browser state if needed.
   */
  dispose(): Promise<void>;
}

// ============================================================
// Marketing Ops Core Types
// ============================================================

// Brand Profile

export interface Address {
  street?: string;
  city?: string;
  postalCode?: string;
  district?: string;
  country?: string;
}

export interface SocialProfiles {
  instagram?: string;
  linkedin?: string;
  facebook?: string;
  twitter?: string;
}

export interface BrandProfile {
  id: string;
  name: string;
  legalName?: string;
  website: string;
  email?: string;
  phone?: string;
  address?: Address;
  social?: SocialProfiles;
  categories?: string[];
  services?: string[];
  languages?: string[];
  businessHours?: Record<string, unknown>;
}

// Market

export type MarketPriority = "primary" | "secondary" | "tertiary";

export interface MarketTarget {
  country: string;
  locale: string;
  enabled: boolean;
  priority: MarketPriority;
}

export interface TargetsFile {
  brandId: string;
  markets: MarketTarget[];
}

// Platform

export type PlatformCategory =
  | "search_maps"
  | "business_directory"
  | "local_directory"
  | "reviews"
  | "education_marketplace"
  | "professional_network"
  | "social_network"
  | "other";

export type RegistrationType = "form" | "api" | "manual" | "email";

export type AutomationMode = "automatic" | "semi-automatic" | "manual";

export interface PlatformDefinition {
  id: string;
  name: string;
  country: string;
  locale: string | null;
  url: string;
  category?: PlatformCategory;
  registrationType: RegistrationType;
  automationMode: AutomationMode;
  requiresLogin: boolean;
  requiresCaptcha: boolean;
  requiresEmailVerification: boolean;
  requiresPhoneVerification: boolean;
  enabled: boolean;
  notes?: string;
}

// Listing

export type ListingStatus =
  | "pending"
  | "manual_required"
  | "in_progress"
  | "submitted"
  | "verification_required"
  | "verified"
  | "rejected"
  | "disabled";

export type ListingPriority = "critical" | "high" | "medium" | "low";

export interface ListingEntry {
  platform_id: string;
  enabled: boolean;
  priority: ListingPriority;
  status: ListingStatus;
  listing_url?: string;
  last_checked?: string;
  notes?: string;
}

// Operational Summary

export interface OperationalSummary {
  brand: string;
  market: string;
  locale: string;
  totalPlatforms: number;
  enabled: number;
  pending: number;
  inProgress: number;
  submitted: number;
  verificationRequired: number;
  verified: number;
  rejected: number;
  disabled: number;
  dataQualityAlerts: string[];
}

// Status Manager

export interface PlatformStatus {
  platform: PlatformDefinition;
  listing: ListingEntry | null;
  status: ListingStatus;
  source: "global" | "market" | "both";
  issues: string[];
}
