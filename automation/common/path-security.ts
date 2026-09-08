import { resolve, relative, isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";

const BRAND_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MARKET_REGEX = /^[A-Z]{2}$/;

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export function validateBrandId(brandId: string): void {
  if (!brandId || typeof brandId !== "string") {
    throw new PathSecurityError("Brand ID is required");
  }
  if (brandId.includes("\0")) {
    throw new PathSecurityError("Brand ID contains null bytes");
  }
  if (brandId.includes("..") || brandId.includes("/") || brandId.includes("\\")) {
    throw new PathSecurityError("Brand ID contains path traversal characters");
  }
  if (brandId.includes(" ")) {
    throw new PathSecurityError("Brand ID contains spaces");
  }
  if (isAbsolute(brandId)) {
    throw new PathSecurityError("Brand ID is an absolute path");
  }
  if (/%[0-9a-fA-F]{2}/.test(brandId)) {
    throw new PathSecurityError("Brand ID contains URL-encoded characters");
  }
  if (!BRAND_ID_REGEX.test(brandId)) {
    throw new PathSecurityError(
      "Brand ID must contain only lowercase letters, numbers, and hyphens",
    );
  }
}

export function validateMarket(market: string): void {
  if (!market || typeof market !== "string") {
    throw new PathSecurityError("Market code is required");
  }
  if (market.includes("\0")) {
    throw new PathSecurityError("Market code contains null bytes");
  }
  if (!MARKET_REGEX.test(market)) {
    throw new PathSecurityError("Market code must be exactly two uppercase letters (ISO alpha-2)");
  }
}

function getNearestExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (current !== resolve(current, "..")) {
    try {
      statSync(current);
      return current;
    } catch {
      current = resolve(current, "..");
    }
  }
  return current;
}

export function validatePathInsideRoot(resolvedPath: string, rootDir: string): void {
  const root = resolve(rootDir);
  const resolved = resolve(resolvedPath);

  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathSecurityError("Path resolves outside repository root");
  }

  let rootExists = false;
  try {
    statSync(root);
    rootExists = true;
  } catch {
    // root doesn't exist yet, skip ancestor-based checks
  }

  if (rootExists) {
    const nearestExisting = getNearestExistingAncestor(resolved);
    const nearestRel = relative(root, nearestExisting);

    if (nearestRel.startsWith("..") || isAbsolute(nearestRel)) {
      throw new PathSecurityError("Path resolves outside repository root");
    }

    try {
      const realRoot = realpathSync(root);
      const realNearest = realpathSync(nearestExisting);
      const realRel = relative(realRoot, realNearest);

      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new PathSecurityError("Path resolves outside repository root via symlink");
      }

      if (nearestExisting !== resolved) {
        const tail = relative(nearestExisting, resolved);
        const realResolved = resolve(realNearest, tail);
        const realTailRel = relative(realRoot, realResolved);

        if (realTailRel.startsWith("..") || isAbsolute(realTailRel)) {
          throw new PathSecurityError("Path resolves outside repository root via symlink");
        }
      }
    } catch (err) {
      if (err instanceof PathSecurityError) {
        throw err;
      }
    }
  }
}

export function safeResolve(rootDir: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (seg.includes("\0")) {
      throw new PathSecurityError("Path segment contains null bytes");
    }
    if (/%[0-9a-fA-F]{2}/.test(seg)) {
      throw new PathSecurityError("Path segment contains URL-encoded characters");
    }
  }

  const resolved = resolve(rootDir, ...segments);
  if (resolved.includes("\0")) {
    throw new PathSecurityError("Resolved path contains null bytes");
  }
  validatePathInsideRoot(resolved, rootDir);
  return resolved;
}
