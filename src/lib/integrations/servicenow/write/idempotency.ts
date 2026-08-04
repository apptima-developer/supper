import { createHash } from "node:crypto";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteCommandInput,
  ServiceNowWritePayloadByType,
} from "./types";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function segment(value: string | undefined) {
  const material = value || "";
  return `${Buffer.byteLength(material, "utf8")}:${material}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildServiceNowWritePayloadMaterial(
  payload: ServiceNowWritePayloadByType[ServiceNowWriteCommandInput["commandType"]],
) {
  return Object.entries(payload)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, value]) => {
      if (typeof value === "string") return `s${segment(key)}${segment(value)}`;
      const references = Object.entries(value || {})
        .sort(([left], [right]) => compareText(left, right))
        .map(([referenceKey, referenceValue]) => (
          `${segment(referenceKey)}${segment(referenceValue)}`
        ))
        .join("|");
      return `o${segment(key)}${references}`;
    })
    .join("|");
}

export function buildServiceNowWriteCommandMaterialHash(
  input: Pick<ServiceNowWriteCommandInput, "commandType" | "sourceType" | "sourceEntityReference" | "payload"> & {
    operationReference: string;
    maxAttempts: number;
  },
  connectionId: string,
  mappingId: string,
  targetTable: string,
) {
  return digest([
    "servicenow-write-command-material-v1",
    segment(connectionId),
    segment(mappingId),
    segment(input.commandType),
    segment(input.sourceType),
    segment(input.sourceEntityReference),
    segment(input.operationReference),
    segment(targetTable),
    segment(buildServiceNowWritePayloadMaterial(input.payload)),
    segment(String(input.maxAttempts)),
  ].join("|"));
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

export function hashServiceNowProviderCorrelationMarker(marker: string) {
  if (!/^SUPPER:[a-f0-9]{64}$/.test(marker)) {
    throw new TypeError("ServiceNow provider correlation marker is invalid");
  }
  return digest(marker);
}

export function serviceNowOperationProviderRequestBudget(
  command: Pick<NormalizedServiceNowWriteCommand, "commandType" | "targetSysId" | "targetNumber">,
  authMode: string,
) {
  const providerRequests = command.commandType === "create_incident"
    ? 3
    : command.targetNumber
      ? 2
      : 1;
  return providerRequests + (authMode === "oauth_client_credentials" ? 1 : 0);
}

export function buildServiceNowNormalizedPayloadMaterial(
  normalized: NormalizedServiceNowWriteCommand,
) {
  const fields = Object.entries(normalized.fields)
    .sort(([left], [right]) => compareText(left, right))
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

export function buildServiceNowWriteConfigurationFingerprint(input: {
  instanceHostname: string;
  incidentTable: string;
  authMode: string;
  credentialVersion?: string;
}) {
  return digest([
    "servicenow-write-configuration-v1",
    segment(input.instanceHostname.trim().toLowerCase()),
    segment(input.incidentTable.trim().toLowerCase()),
    segment(input.authMode.trim().toLowerCase()),
    segment(input.credentialVersion?.trim() || "unversioned"),
  ].join("|"));
}
