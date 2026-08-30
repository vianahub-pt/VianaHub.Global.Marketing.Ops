/**
 * Shared utilities for automation workflows.
 */

export { loadBrand } from "./load-brand.js";
export { loadMarket } from "./load-market.js";
export { loadPlatforms } from "./load-platforms.js";
export { buildStatus, buildSummary, sortByPriority } from "./status-manager.js";
export { generateReport } from "./report-generator.js";
export type {
  AdapterConfig,
  RegistrationResult,
  PlatformAdapter,
  Address,
  SocialProfiles,
  BrandProfile,
  MarketPriority,
  MarketTarget,
  TargetsFile,
  PlatformCategory,
  RegistrationType,
  AutomationMode,
  PlatformDefinition,
  ListingStatus,
  ListingPriority,
  ListingEntry,
  OperationalSummary,
  PlatformStatus,
} from "./types.js";
