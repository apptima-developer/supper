import { createHash } from "node:crypto";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteCommandInput,
} from "./types";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function segment(value: string | undefined) {
  const material = value || "";
  return `${Buffer.byteLength(material, "utf8")}:${material}`;
}

export function buildServiceNowWriteIdempotencyMaterial(
  input: Pick<ServiceNowWriteCommandInput, "commandType" | "sourceType" | "sourceEntityReference"> & {
    operationReference: string;
  },
  connectionId: string,
  targetTable: string,
) {
  return [
    "servicenow-write-v2",
    segment(connectionId),
    segment(input.commandType),
    segment(input.operationReference),
    segment(input.sourceType),
    segment(input.sourceEntityReference),
    segment(targetTable),
  ].join("|");
}

export function buildServiceNowWriteIdempotencyKey(
  input: Pick<ServiceNowWriteCommandInput, "commandType" | "sourceType" | "sourceEntityReference"> & {
    operationReference: string;
  },
  connectionId: string,
  targetTable: string,
) {
  return digest(buildServiceNowWriteIdempotencyMaterial(input, connectionId, targetTable));
}

export function buildServiceNowProviderCorrelationMarker(idempotencyKey: string) {
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) throw new TypeError("ServiceNow write idempotency key is invalid");
  return `SUPPER:${idempotencyKey}`;
}

export function buildServiceNowNormalizedPayloadMaterial(
  normalized: NormalizedServiceNowWriteCommand,
) {
  const fields = Object.entries(normalized.fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${segment(key)}${segment(value)}`)
    .join("|");
  return [
    "servicenow-write-normalized-v2",
    segment(normalized.commandType),
    segment(normalized.targetSysId),
    segment(normalized.targetNumber),
    segment(normalized.providerCorrelationMarker),
    fields,
  ].join("|");
}

export function buildServiceNowNormalizedPayloadHash(normalized: NormalizedServiceNowWriteCommand) {
  return digest(buildServiceNowNormalizedPayloadMaterial(normalized));
}

export function hashServiceNowWriteConfirmationNonce(nonce: string) {
  return digest(`servicenow-write-confirmation-v1|${segment(nonce)}`);
}
