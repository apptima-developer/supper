import { createHash } from "node:crypto";
import { canonicalSerializeIdempotencyMaterial } from "../../idempotency";
import type { NormalizedServiceNowWriteCommand, ServiceNowWriteCommandInput } from "./types";

function digest(value: unknown) {
  return createHash("sha256")
    .update(canonicalSerializeIdempotencyMaterial(value), "utf8")
    .digest("hex");
}

export function buildServiceNowWriteIdempotencyKey(
  input: Pick<ServiceNowWriteCommandInput, "commandType" | "sourceType" | "sourceReference">,
  connectionId: string,
  targetTable: string,
) {
  return digest({
    version: "servicenow-write-v1",
    connectionId,
    commandType: input.commandType,
    sourceType: input.sourceType,
    sourceReference: input.sourceReference,
    targetTable,
  });
}

export function buildServiceNowNormalizedPayloadHash(normalized: NormalizedServiceNowWriteCommand) {
  return digest(normalized);
}
