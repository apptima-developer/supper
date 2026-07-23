import { describe, expect, it } from "vitest";
import { buildServiceNowNormalizedPayloadHash, buildServiceNowWriteIdempotencyKey } from "./idempotency";

describe("ServiceNow write idempotency", () => {
  const logical = {
    commandType: "create_incident" as const,
    sourceType: "manual" as const,
    sourceReference: "manual:stable-reference",
  };

  it("derives one deterministic logical key independent of object identity", () => {
    expect(buildServiceNowWriteIdempotencyKey({ ...logical }, "connection-a", "incident"))
      .toBe(buildServiceNowWriteIdempotencyKey({ ...logical }, "connection-a", "incident"));
  });

  it("changes the logical key when source identity changes", () => {
    expect(buildServiceNowWriteIdempotencyKey(logical, "connection-a", "incident"))
      .not.toBe(buildServiceNowWriteIdempotencyKey({ ...logical, sourceReference: "manual:other" }, "connection-a", "incident"));
  });

  it("hashes normalized payload canonically and detects changed material", () => {
    const first = { commandType: "create_incident" as const, fields: { description: "D", short_description: "S" } };
    const reordered = { commandType: "create_incident" as const, fields: { short_description: "S", description: "D" } };
    const changed = { commandType: "create_incident" as const, fields: { short_description: "Changed", description: "D" } };
    expect(buildServiceNowNormalizedPayloadHash(first)).toBe(buildServiceNowNormalizedPayloadHash(reordered));
    expect(buildServiceNowNormalizedPayloadHash(first)).not.toBe(buildServiceNowNormalizedPayloadHash(changed));
  });
});
