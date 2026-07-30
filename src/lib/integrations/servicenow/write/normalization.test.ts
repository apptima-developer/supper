import { describe, expect, it } from "vitest";
import {
  buildServiceNowWritePreview,
  normalizeCommand,
  serviceNowDefaultWriteMapping,
  validateServiceNowWriteFieldMapping,
} from "./normalization";

const marker = `SUPPER:${"a".repeat(64)}`;

describe("ServiceNow write normalization", () => {
  it("maps create fields explicitly, omits external references, and owns the correlation marker", () => {
    const normalized = normalizeCommand({
      commandType: "create_incident",
      sourceType: "manual",
      operationReference: "create:test",
      payload: {
        shortDescription: "Short",
        description: "Long description",
        impact: "2",
        urgency: "1",
        projectCode: "P-001",
        externalReferences: { supperTicket: "T-1" },
      },
    }, serviceNowDefaultWriteMapping("create_incident"), marker);
    expect(normalized).toEqual({
      schemaVersion: "servicenow-write-normalized-v2",
      commandType: "create_incident",
      providerCorrelationMarker: marker,
      fields: {
        short_description: "Short",
        description: "Long description",
        impact: "2",
        urgency: "1",
        u_project_code: "P-001",
        correlation_id: marker,
      },
    });
  });

  it("maps exactly one update target separately from writable fields", () => {
    const normalized = normalizeCommand({
      commandType: "update_incident",
      sourceType: "manual",
      operationReference: "update:test",
      payload: {
        sysId: "a".repeat(32),
        state: "2",
        shortDescription: "Changed",
      },
    }, serviceNowDefaultWriteMapping("update_incident"));
    expect(normalized.targetSysId).toBe("a".repeat(32));
    expect(normalized.targetNumber).toBeUndefined();
    expect(normalized.fields).toEqual({ state: "2", short_description: "Changed" });
  });

  it.each([
    ["add_comment" as const, "comments"],
    ["add_work_note" as const, "work_notes"],
  ])("maps %s into the exact journal field", (commandType, target) => {
    const normalized = normalizeCommand({
      commandType,
      sourceType: "manual",
      operationReference: `${commandType}:test`,
      payload: { number: "INC100", text: "Bounded update" },
    }, serviceNowDefaultWriteMapping(commandType));
    expect(normalized.fields).toEqual({ [target]: "Bounded update" });
  });

  it("requires the exact reviewed mapping and rejects omissions, duplicates, and reserved targets", () => {
    const valid = serviceNowDefaultWriteMapping("create_incident");
    expect(validateServiceNowWriteFieldMapping("create_incident", valid)).toEqual(valid);
    expect(() => validateServiceNowWriteFieldMapping("create_incident", {
      ...valid,
      shortDescription: "u_summary",
    })).toThrow(/allowlist/i);
    const missing = { ...valid };
    delete missing.description;
    expect(() => validateServiceNowWriteFieldMapping("create_incident", missing)).toThrow(/allowlist/i);
    expect(() => validateServiceNowWriteFieldMapping("create_incident", {
      ...valid,
      description: valid.shortDescription,
    })).toThrow(/allowlist/i);
    expect(() => validateServiceNowWriteFieldMapping("create_incident", {
      ...valid,
      shortDescription: "correlation_id",
    })).toThrow(/allowlist/i);
  });

  it("produces a browser-safe preview without narrative values", () => {
    const preview = buildServiceNowWritePreview({
      schemaVersion: "servicenow-write-normalized-v2",
      commandType: "create_incident",
      providerCorrelationMarker: marker,
      fields: {
        correlation_id: marker,
        description: "Sensitive customer narrative",
        impact: "2",
        company: "a".repeat(32),
      },
    });
    expect(preview.fields).toContainEqual({ name: "description", kind: "text", length: 28 });
    expect(preview.fields).toContainEqual({ name: "impact", kind: "enum", length: 1, value: "2" });
    expect(JSON.stringify(preview)).not.toContain("Sensitive customer narrative");
  });
});
