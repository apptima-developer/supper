import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ExternalMessageId,
  ExternalTicketId,
  IntegrationEventId,
  IntegrationEventType,
  IntegrationIdempotencyKey,
  IntegrationOperation,
  IntegrationProvider,
} from "./contracts";
import {
  externalMessageIdSchema,
  externalTicketIdSchema,
  integrationEventIdSchema,
  integrationEventTypeSchema,
  integrationOperationSchema,
  integrationProviderSchema,
  idempotencyKeySchema,
} from "./schemas";

const maximumCanonicalDepth = 8;
const maximumCanonicalBytes = 32 * 1024;
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function canonicalizeValue(value: unknown, depth: number, ancestors: WeakSet<object>): string {
  if (depth > maximumCanonicalDepth) throw new TypeError("Idempotency material exceeds the maximum depth");
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "b:1" : "b:0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Idempotency material contains a non-finite number");
    return `d:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Idempotency material contains unsupported ${typeof value}`);
  }
  if (!value || typeof value !== "object") throw new TypeError("Idempotency material is unsupported");
  if (ancestors.has(value)) throw new TypeError("Idempotency material contains a cycle");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `a:[${value.map((item) => canonicalizeValue(item, depth + 1, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Idempotency material must use plain objects");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Idempotency material contains symbol keys");
    const sortedKeys = (keys as string[]).sort();
    return `o:{${sortedKeys.map((key) => {
      if (forbiddenObjectKeys.has(key)) throw new TypeError("Idempotency material contains a forbidden object key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new TypeError("Idempotency material accessors are unsupported");
      return `${JSON.stringify(key)}:${canonicalizeValue(descriptor.value, depth + 1, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalSerializeIdempotencyMaterial(value: unknown) {
  const serialized = canonicalizeValue(value, 0, new WeakSet());
  if (Buffer.byteLength(serialized, "utf8") > maximumCanonicalBytes) {
    throw new TypeError("Idempotency material exceeds the maximum encoded size");
  }
  return serialized;
}

const idempotencyMaterialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    provider: integrationProviderSchema,
    operation: integrationOperationSchema,
    externalMessageId: externalMessageIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("ticket"),
    provider: integrationProviderSchema,
    operation: integrationOperationSchema,
    externalTicketId: externalTicketIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("event"),
    provider: integrationProviderSchema,
    operation: integrationOperationSchema,
    eventId: integrationEventIdSchema,
    eventType: integrationEventTypeSchema,
  }).strict(),
]);

export type IdempotencyMaterial = z.infer<typeof idempotencyMaterialSchema>;

export function deriveIdempotencyKey(material: IdempotencyMaterial): IntegrationIdempotencyKey {
  const stableMaterial = idempotencyMaterialSchema.parse(material);
  const digest = createHash("sha256")
    .update(canonicalSerializeIdempotencyMaterial(stableMaterial), "utf8")
    .digest("hex");
  return idempotencyKeySchema.parse(`supper:v1:${digest}`);
}

export function deriveMessageIdempotencyKey(input: {
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  externalMessageId: ExternalMessageId;
}) {
  return deriveIdempotencyKey({ kind: "message", ...input });
}

export function deriveTicketIdempotencyKey(input: {
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  externalTicketId: ExternalTicketId;
}) {
  return deriveIdempotencyKey({ kind: "ticket", ...input });
}

export function deriveEventIdempotencyKey(input: {
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  eventId: IntegrationEventId;
  eventType: IntegrationEventType;
}) {
  return deriveIdempotencyKey({ kind: "event", ...input });
}
