import { createHash, randomUUID } from "node:crypto";

export type RunId = string & { readonly __brand: "RunId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };
export type PayloadFingerprint = string & { readonly __brand: "PayloadFingerprint" };

export interface RunIdentity {
  readonly brandId: string;
  readonly market: string;
  readonly platform: string;
  readonly operation: string;
}

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

const sensitiveKeyPattern =
  /(?:token|secret|password|passwd|passphrase|cookie|session(?:id)?|authorization|credential|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key)/i;
const jwtPattern = /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
const bearerPattern = /^bearer\s+\S+$/i;
const cookiePattern = /(?:^|;\s*)(?:session|token|auth|sid)[^=]*=/i;
const pemPattern = /^-----BEGIN [A-Z0-9 ]+-----/;

function rejectSensitiveValue(value: string, path: string): void {
  if (
    jwtPattern.test(value) ||
    bearerPattern.test(value) ||
    cookiePattern.test(value) ||
    pemPattern.test(value)
  ) {
    throw new Error(`Sensitive data is not allowed in payload at ${path}`);
  }
}

function rejectUnexpectedProperties(value: object, path: string, allowedKeys: Set<string>): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowedKeys.has(key)) {
      throw new Error(`Payload contains a non-JSON property at ${path}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`Payload contains an accessor property at ${path}.${key}`);
    }
  }
}

function canonicalize(value: unknown, path = "$", seen = new Set<object>()): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    rejectSensitiveValue(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Payload contains a non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`Payload contains an unsupported value at ${path}`);
  }
  if (seen.has(value)) {
    throw new Error(`Payload contains a circular reference at ${path}`);
  }
  seen.add(value);

  let result: string;
  if (Array.isArray(value)) {
    const allowedKeys = new Set<string>(["length"]);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      if (!Object.hasOwn(value, key)) {
        throw new Error(`Payload contains a sparse array at ${path}`);
      }
      allowedKeys.add(key);
    }
    rejectUnexpectedProperties(value, path, allowedKeys);
    result = `[${value
      .map((item, index) => canonicalize(item, `${path}[${index}]`, seen))
      .join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Payload contains a non-plain object at ${path}`);
    }
    const keys = Object.keys(value);
    rejectUnexpectedProperties(value, path, new Set(keys));
    const entries = keys.sort().map((key) => {
      if (sensitiveKeyPattern.test(key)) {
        throw new Error(`Sensitive field "${key}" is not allowed in payload at ${path}`);
      }
      const objectValue = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${canonicalize(objectValue, `${path}.${key}`, seen)}`;
    });
    result = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function validateRunIdentity(identity: RunIdentity): void {
  if (identity === null || typeof identity !== "object") {
    throw new Error("Run identity must be a plain object");
  }

  const prototype = Object.getPrototypeOf(identity);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Run identity must be a plain object");
  }

  const fields: readonly (keyof RunIdentity)[] = ["brandId", "market", "platform", "operation"];
  const keys = Object.keys(identity);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(identity, field))) {
    throw new Error("Run identity must contain exactly brandId, market, platform and operation");
  }
  rejectUnexpectedProperties(identity, "identity", new Set(fields));

  for (const field of fields) {
    const value = identity[field];
    if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
      throw new Error(`Run identity field "${field}" must be a non-empty string`);
    }
    const containsControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (value !== value.trim() || containsControlCharacter) {
      throw new Error(`Run identity field "${field}" contains invalid characters`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createRunId(): RunId {
  return randomUUID() as RunId;
}

export function fingerprintPayload(payload: unknown): PayloadFingerprint {
  return sha256(canonicalize(payload)) as PayloadFingerprint;
}

export function computeIdempotencyKey(identity: RunIdentity, payload: unknown): IdempotencyKey {
  validateRunIdentity(identity);
  const canonicalIdentity = canonicalize(identity);
  const canonicalPayload = canonicalize(payload);
  return sha256(`identity:${canonicalIdentity}|payload:${canonicalPayload}`) as IdempotencyKey;
}
