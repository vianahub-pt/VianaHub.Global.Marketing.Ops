import { z } from "zod";

// ============================================================
// Brand Profile Schemas
// ============================================================

export const AddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  district: z.string().optional(),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, "Country must be ISO alpha-2 uppercase")
    .optional(),
});

export const SocialProfilesSchema = z.object({
  instagram: z.string().url().optional(),
  linkedin: z.string().url().optional(),
  facebook: z.string().url().optional(),
  twitter: z.string().url().optional(),
});

export const BusinessDayHoursSchema = z
  .object({
    closed: z.boolean(),
    open: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm")
      .optional(),
    close: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm")
      .optional(),
  })
  .refine(
    (data) => {
      if (data.closed) {
        return !data.open && !data.close;
      }
      return data.open !== undefined && data.close !== undefined;
    },
    {
      message: "Closed days must not have open/close times; open days must have both",
    },
  )
  .refine(
    (data) => {
      if (!data.closed && data.open && data.close) {
        return data.open < data.close;
      }
      return true;
    },
    { message: "Opening time must be before closing time" },
  );

export const BusinessHoursSchema = z.object({
  monday: BusinessDayHoursSchema,
  tuesday: BusinessDayHoursSchema,
  wednesday: BusinessDayHoursSchema,
  thursday: BusinessDayHoursSchema,
  friday: BusinessDayHoursSchema,
  saturday: BusinessDayHoursSchema,
  sunday: BusinessDayHoursSchema,
});

export const BrandProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Brand ID must be kebab-case"),
    name: z.string().min(1),
    legalName: z.string().optional(),
    website: z.string().url(),
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().optional().or(z.literal("")),
    address: AddressSchema.optional(),
    social: SocialProfilesSchema.optional(),
    categories: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    languagesTaught: z.array(z.string()).optional(),
    supportedLocales: z.array(z.string()).optional(),
    businessHours: BusinessHoursSchema.optional(),
  })
  .strict();

// ============================================================
// Market Schemas
// ============================================================

export const MarketTargetSchema = z
  .object({
    country: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/, "Country must be ISO alpha-2 uppercase"),
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, "Locale must be like pt-PT"),
    enabled: z.boolean(),
    priority: z.enum(["primary", "secondary", "tertiary"]),
  })
  .strict();

export const TargetsFileSchema = z
  .object({
    brandId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Brand ID must be kebab-case"),
    markets: z.array(MarketTargetSchema),
  })
  .strict()
  .refine(
    (data) => {
      const countries = data.markets.map((m) => m.country);
      return countries.length === new Set(countries).size;
    },
    { message: "Duplicate market countries found" },
  );

// ============================================================
// Platform Schemas
// ============================================================

export const PricingModelSchema = z.enum(["free", "freemium", "credits", "paid", "unknown"]);

export const PlatformDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    country: z
      .string()
      .regex(/^[A-Z]{2}$|^GLOBAL$/, "Country must be ISO alpha-2 uppercase or GLOBAL"),
    locale: z
      .string()
      .regex(/^[a-z]{2}-[A-Z]{2}$/)
      .nullish(),
    url: z.string().url(),
    category: z
      .enum([
        "search_maps",
        "business_directory",
        "local_directory",
        "reviews",
        "education_marketplace",
        "professional_network",
        "social_network",
        "other",
      ])
      .optional(),
    registrationType: z.enum(["form", "api", "manual", "email"]),
    automationMode: z.enum(["automatic", "semi-automatic", "manual"]),
    requiresLogin: z.boolean().nullable(),
    requiresCaptcha: z.boolean().nullable(),
    requiresEmailVerification: z.boolean().nullable(),
    requiresPhoneVerification: z.boolean().nullable(),
    pricingModel: PricingModelSchema.optional(),
    enabled: z.boolean(),
    officialSourceUrl: z.string().url().optional(),
    lastVerifiedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
      .optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.automationMode === "automatic") {
        return (
          data.requiresLogin === false &&
          data.requiresCaptcha === false &&
          data.requiresEmailVerification === false &&
          data.requiresPhoneVerification === false
        );
      }
      return true;
    },
    {
      message:
        "Automatic platforms must explicitly declare requiresLogin, requiresCaptcha, requiresEmailVerification, requiresPhoneVerification as false",
    },
  );

// ============================================================
// Listing Schemas
// ============================================================

export const ListingStatusSchema = z.enum([
  "pending",
  "manual_required",
  "in_progress",
  "submitted",
  "verification_required",
  "verified",
  "rejected",
  "disabled",
]);

export const ListingPrioritySchema = z.enum(["critical", "high", "medium", "low"]);

export const ListingEntrySchema = z
  .object({
    platform_id: z.string().min(1),
    listing_name: z.string().optional(),
    enabled: z.string().refine((v) => v === "true" || v === "false", "Must be true or false"),
    priority: ListingPrioritySchema,
    status: ListingStatusSchema,
    listing_url: z.string().optional().or(z.literal("")),
    last_checked: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
      .optional()
      .or(z.literal("")),
    notes: z.string().optional(),
  })
  .strict();

export type ValidatedListingEntry = {
  platform_id: string;
  listing_name?: string;
  enabled: boolean;
  priority: z.infer<typeof ListingPrioritySchema>;
  status: z.infer<typeof ListingStatusSchema>;
  listing_url?: string;
  last_checked?: string;
  notes?: string;
};

export function validateListing(raw: Record<string, string>): ValidatedListingEntry {
  const result = ListingEntrySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid listing for "${raw.platform_id}": ${issues}`);
  }
  return {
    ...result.data,
    enabled: result.data.enabled === "true",
  };
}
