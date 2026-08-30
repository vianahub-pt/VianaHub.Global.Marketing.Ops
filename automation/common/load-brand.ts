import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrandProfile } from "./types.js";

const REQUIRED_FIELDS = ["id", "name", "website"] as const;

export function loadBrand(brandId: string, rootDir?: string): BrandProfile {
  const root = rootDir ?? resolve(process.cwd());
  const filePath = resolve(root, "brands", brandId, "business-profile", "master-data.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Brand profile not found: ${filePath}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in brand profile: ${filePath}`);
  }

  for (const field of REQUIRED_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required field "${field}" in ${filePath}`);
    }
  }

  const profile: BrandProfile = {
    id: data.id as string,
    name: data.name as string,
    website: data.website as string,
  };

  if (data.legalName) profile.legalName = data.legalName as string;
  if (data.email) profile.email = data.email as string;
  if (data.phone) profile.phone = data.phone as string;
  if (data.address) profile.address = data.address as BrandProfile["address"];
  if (data.social) profile.social = data.social as BrandProfile["social"];
  if (data.categories) profile.categories = data.categories as string[];
  if (data.services) profile.services = data.services as string[];
  if (data.languages) profile.languages = data.languages as string[];
  if (data.businessHours) profile.businessHours = data.businessHours as Record<string, unknown>;

  return profile;
}
