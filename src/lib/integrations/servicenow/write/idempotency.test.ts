import { describe, expect, it } from "vitest";
import {
  buildServiceNowNormalizedPayloadHash,
  buildServiceNowProviderCorrelationMarker,
  buildServiceNowWriteIdempotencyKey,
  hashServiceNowWriteConfirmationNonce,
} from "./idempotency";
import type { NormalizedServiceNowWriteCommand } from "./types";

describe("ServiceNow write idempotency", () => {
  const logical = {
    commandType: "create_incident" as const,
    sourceType: "supper_ticket" as const,
    sourceEntityReference: "ticket:T-100",
    operationReference: "create:initial",
  };

  it("derives one deterministic v2 key independent of object identity", () => {
    const key = buildServiceNowWriteIdempotencyKey({ ...logical }, "connection-a", "incident");
    expect(key).toBe(buildServiceNowWriteIdempotencyKey({ ...logical }, "connection-a", "incident"));
    expect(key).toBe("06cfd138fb4bbab5d8a82359e05d667ac6df4317f5e1259b22b08fec510ac1a6");
  });

  it("permits distinct operations for the same source entity", () => {
    expect(buildServiceNowWriteIdempotencyKey(logical, "connection-a", "incident"))
      .not.toBe(buildServiceNowWriteIdempotencyKey({
        ...logical,
        operationReference: "comment:follow-up-1",
      }, "connection-a", "incident"));
  });

  it("changes the key when connection, source identity, or table changes", () => {
    const baseline = buildServiceNowWriteIdempotencyKey(logical, "connection-a", "incident");
    expect(buildServiceNowWriteIdempotencyKey(logical, "connection-b", "incident")).not.toBe(baseline);
    expect(buildServiceNowWriteIdempotencyKey({
      ...logical,
      sourceEntityReference: "ticket:T-101",
    }, "connection-a", "incident")).not.toBe(baseline);
    expect(buildServiceNowWriteIdempotencyKey(logical, "connection-a", "u_incident")).not.toBe(baseline);
  });

  it("hashes normalized payload canonically and detects changed material", () => {
    const base = {
      schemaVersion: "servicenow-write-normalized-v2" as const,
      commandType: "create_incident" as const,
      providerCorrelationMarker: "SUPPER:06cfd138fb4bbab5d8a82359e05d667ac6df4317f5e1259b22b08fec510ac1a6",
    };
    const first: NormalizedServiceNowWriteCommand = {
      ...base,
      fields: { correlation_id: base.providerCorrelationMarker, description: "D", short_description: "S" },
    };
    const reordered: NormalizedServiceNowWriteCommand = {
      ...base,
      fields: { short_description: "S", description: "D", correlation_id: base.providerCorrelationMarker },
    };
    const changed: NormalizedServiceNowWriteCommand = {
      ...base,
      fields: { short_description: "Changed", description: "D", correlation_id: base.providerCorrelationMarker },
    };
    expect(buildServiceNowNormalizedPayloadHash(first)).toBe(buildServiceNowNormalizedPayloadHash(reordered));
    expect(buildServiceNowNormalizedPayloadHash(first))
      .toBe("26096def22561832e72682010c663017acde6c4104fd6a9c62aee17451b01965");
    expect(buildServiceNowNormalizedPayloadHash(first)).not.toBe(buildServiceNowNormalizedPayloadHash(changed));
  });

  it("derives bounded provider markers and confirmation hashes without retaining nonce text", () => {
    const key = "b".repeat(64);
    expect(buildServiceNowProviderCorrelationMarker(key)).toBe(`SUPPER:${key}`);
    expect(hashServiceNowWriteConfirmationNonce("nonce-value-with-sufficient-entropy"))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(hashServiceNowWriteConfirmationNonce("nonce-value-with-sufficient-entropy"))
      .not.toContain("nonce-value");
  });
});
