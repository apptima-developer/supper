import { describe, expect, it } from "vitest";
import { buildServiceNowWritePreview, normalizeCommand, validateServiceNowWriteFieldMapping } from "./normalization";

describe("ServiceNow write normalization", () => {
  it("maps create Incident fields explicitly and omits external reference material", () => {
    const normalized = normalizeCommand({
      commandType: "create_incident",
      sourceType: "manual",
      sourceReference: "manual:create",
      payload: {
        shortDescription: "Short",
        description: "Long description",
        impact: "2",
        urgency: "1",
        projectCode: "P-001",
        externalReferences: { supperTicket: "T-1" },
      },
    });
    expect(normalized).toEqual({
      commandType: "create_incident",
      fields: {
        short_description: "Short",
        description: "Long description",
        impact: "2",
        urgency: "1",
        u_project_code: "P-001",
      },
    });
  });

  it("maps update target separately from writable fields", () => {
    const normalized = normalizeCommand({
      commandType: "update_incident",
      sourceType: "manual",
      sourceReference: "manual:update",
      payload: {
        sysId: "a".repeat(32),
        number: "INC100",
        state: "2",
        shortDescription: "Changed",
      },
    });
    expect(normalized.targetSysId).toBe("a".repeat(32));
    expect(normalized.targetNumber).toBe("INC100");
    expect(normalized.fields).toEqual({ state: "2", short_description: "Changed" });
  });

  it.each([
    ["add_comment" as const, "comments"],
    ["add_work_note" as const, "work_notes"],
  ])("maps %s into the correct journal field", (commandType, target) => {
    const normalized = normalizeCommand({
      commandType,
      sourceType: "manual",
      sourceReference: `manual:${commandType}`,
      payload: { number: "INC100", text: "Bounded update" },
    });
    expect(normalized.fields).toEqual({ [target]: "Bounded update" });
  });

  it("validates configured mapping keys and rejects sensitive targets", () => {
    expect(validateServiceNowWriteFieldMapping("create_incident", {
      shortDescription: "u_summary",
      description: "description",
    })).toEqual({ shortDescription: "u_summary", description: "description" });
    expect(() => validateServiceNowWriteFieldMapping("create_incident", {
      shortDescription: "access_token",
    })).toThrow(/mapping/i);
    expect(() => validateServiceNowWriteFieldMapping("create_incident", {
      unexpectedSource: "u_value",
    })).toThrow(/mapping/i);
  });

  it("produces a browser-safe mapping preview without long text values", () => {
    const preview = buildServiceNowWritePreview({
      commandType: "create_incident",
      fields: { description: "Sensitive customer narrative", impact: "2", company: "company-id" },
    });
    expect(preview.fields).toContainEqual({ name: "description", kind: "text", length: 28 });
    expect(preview.fields).toContainEqual({ name: "impact", kind: "enum", length: 1, value: "2" });
    expect(JSON.stringify(preview)).not.toContain("Sensitive customer narrative");
  });
});
