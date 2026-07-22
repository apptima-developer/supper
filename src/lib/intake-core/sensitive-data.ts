import { containsControlCharacters } from "@/lib/integrations/validation";

export type IntakeJsonKeyClassification = "safe" | "sensitive" | "forbidden-provider-payload" | "invalid";

const sensitiveWords = new Set([
  "authorization", "authentication", "credential", "credentials", "cookie", "password",
  "passphrase", "secret", "token", "bearer",
]);

const sensitivePhrases = new Set([
  "access token", "refresh token", "api key", "private key", "client secret", "channel secret",
  "channel access token", "signed url", "signature secret", "webhook secret", "session secret",
  "supabase service role key", "service role key", "authentication credential",
]);

const forbiddenProviderPayloadKeys = new Set([
  "raw payload", "webhook body", "raw headers", "authorization headers", "complete profile", "raw event",
]);

function hasWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function normalizeIntakeJsonKey(value: string): string | undefined {
  if (!value || !hasWellFormedUnicode(value) || containsControlCharacters(value) || /[^\x20-\x7e]/.test(value)) {
    return undefined;
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[\s_.:\-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyIntakeJsonKey(value: string): IntakeJsonKeyClassification {
  if (value === "__proto__" || value === "constructor" || value === "prototype") return "invalid";
  const normalized = normalizeIntakeJsonKey(value);
  if (!normalized) return "invalid";
  if (forbiddenProviderPayloadKeys.has(normalized)) return "forbidden-provider-payload";
  const words = normalized.split(" ");
  if (words.some((word) => sensitiveWords.has(word))) return "sensitive";
  if (words.includes("signed") && words.includes("url")) return "sensitive";
  for (const phrase of sensitivePhrases) {
    if (` ${normalized} `.includes(` ${phrase} `)) return "sensitive";
  }
  return "safe";
}

export function findUnsafeIntakeJsonKey(value: unknown): { path: Array<string | number>; key: string; classification: Exclude<IntakeJsonKeyClassification, "safe"> } | undefined {
  const ancestors = new WeakSet<object>();
  function visit(current: unknown, path: Array<string | number>): ReturnType<typeof findUnsafeIntakeJsonKey> {
    if (!current || typeof current !== "object") return undefined;
    if (ancestors.has(current)) return { path, key: "<cycle>", classification: "invalid" };
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          const found = visit(current[index], [...path, index]);
          if (found) return found;
        }
        return undefined;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return { path, key: "<prototype>", classification: "invalid" };
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") return { path, key: "<symbol>", classification: "invalid" };
        const classification = classifyIntakeJsonKey(key);
        if (classification !== "safe") return { path: [...path, key], key, classification };
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || descriptor.get || descriptor.set) return { path: [...path, key], key, classification: "invalid" };
        const found = visit(descriptor.value, [...path, key]);
        if (found) return found;
      }
      return undefined;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, []);
}

export function assertNoSensitiveIntakeData(value: unknown) {
  const found = findUnsafeIntakeJsonKey(value);
  if (!found) return;
  if (found.classification === "sensitive") throw new TypeError("Credentials are not accepted in Unified Intake JSON");
  if (found.classification === "forbidden-provider-payload") throw new TypeError("Raw provider payload fields are not accepted in Unified Intake JSON");
  throw new TypeError("Unified Intake JSON contains an invalid key");
}
