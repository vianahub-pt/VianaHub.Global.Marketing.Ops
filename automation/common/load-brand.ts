import { readFileSync } from "node:fs";
import type { BrandProfile } from "./types.js";
import { validateBrandId, safeResolve } from "./path-security.js";
import { BrandProfileSchema } from "./schemas.js";

export function loadBrand(brandId: string, rootDir?: string): BrandProfile {
  validateBrandId(brandId);

  const root = rootDir ?? process.cwd();
  const filePath = safeResolve(root, "brands", brandId, "business-profile", "master-data.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Brand profile not found: ${filePath}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in brand profile: ${filePath}`);
  }

  const validated = BrandProfileSchema.safeParse(data);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid brand profile: ${issues}`);
  }

  return validated.data as BrandProfile;
}
