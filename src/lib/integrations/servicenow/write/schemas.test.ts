import { describe, expect, it } from "vitest";
import {
  createServiceNowWriteCommandRequestSchema,
  serviceNowCreateIncidentInputSchema,
  serviceNowUpdateIncidentInputSchema,
} from "./schemas";

describe("ServiceNow write schemas", () => {
  it("accepts a bounded create Incident command", () => {
    const input = {
      commandType: "create_incident",
      sourceType: "manual",
      sourceReference: "manual:test-create",
      payload: {
        shortDescription: "Cannot open document",
        description: "The document viewer reports a bounded test error.",
        impact: "2",
        urgency: "2",
        externalReferences: { supperTicket: "TICKET-100" },
      },
    };
    expect(createServiceNowWriteCommandRequestSchema.parse(input)).toEqual(input);
  });

  it("rejects missing required create fields", () => {
    expect(() => serviceNowCreateIncidentInputSchema.parse({ description: "Only a description" })).toThrow();
  });

  it.each([
    [{ sysId: "a".repeat(32), state: "99" }, "state"],
    [{ sysId: "a".repeat(32), impact: "4" }, "impact"],
    [{ sysId: "a".repeat(32), urgency: "0" }, "urgency"],
  ])("rejects invalid bounded update values in %s", (input, field) => {
    expect(field).toBeTruthy();
    expect(() => serviceNowUpdateIncidentInputSchema.parse(input)).toThrow();
  });

  it("requires a target and at least one update field", () => {
    expect(() => serviceNowUpdateIncidentInputSchema.parse({ shortDescription: "Updated" })).toThrow();
    expect(() => serviceNowUpdateIncidentInputSchema.parse({ sysId: "a".repeat(32) })).toThrow();
  });

  it("rejects credential-like external reference keys", () => {
    expect(() => serviceNowCreateIncidentInputSchema.parse({
      shortDescription: "Test",
      description: "Test",
      externalReferences: { apiToken: "not-allowed" },
    })).toThrow(/sensitive/i);
  });

  it("rejects arbitrary properties and oversized journal content", () => {
    expect(() => createServiceNowWriteCommandRequestSchema.parse({
      commandType: "add_comment",
      sourceType: "manual",
      sourceReference: "manual:test",
      payload: { sysId: "a".repeat(32), text: "ok", rawResponse: {} },
    })).toThrow();
    expect(() => createServiceNowWriteCommandRequestSchema.parse({
      commandType: "add_work_note",
      sourceType: "manual",
      sourceReference: "manual:test",
      payload: { sysId: "a".repeat(32), text: "x".repeat(20_001) },
    })).toThrow();
  });
});
