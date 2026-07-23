import { classifyIntakeJsonKey } from "@/lib/intake-core/sensitive-data";
import { serviceNowWriteCommandTypeSchema } from "./schemas";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteCommandInput,
  ServiceNowWriteCommandType,
  ServiceNowWritePreview,
} from "./types";

export type ServiceNowWriteFieldMapping = Record<string, string>;

const defaultMappings: Record<ServiceNowWriteCommandType, ServiceNowWriteFieldMapping> = {
  create_incident: {
    shortDescription: "short_description",
    description: "description",
    callerId: "caller_id",
    category: "category",
    subcategory: "subcategory",
    impact: "impact",
    urgency: "urgency",
    assignmentGroup: "assignment_group",
    contactChannel: "contact_type",
    customer: "company",
    projectCode: "u_project_code",
    supperTicketNo: "correlation_id",
  },
  update_incident: {
    shortDescription: "short_description",
    description: "description",
    state: "state",
    impact: "impact",
    urgency: "urgency",
    assignmentGroup: "assignment_group",
    customer: "company",
    projectCode: "u_project_code",
  },
  add_comment: { text: "comments" },
  add_work_note: { text: "work_notes" },
};

const allowedSourceFields: Record<ServiceNowWriteCommandType, Set<string>> = {
  create_incident: new Set(Object.keys(defaultMappings.create_incident)),
  update_incident: new Set(Object.keys(defaultMappings.update_incident)),
  add_comment: new Set(["text"]),
  add_work_note: new Set(["text"]),
};

function validateTargetField(value: string) {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(value) || classifyIntakeJsonKey(value) !== "safe") {
    throw Object.assign(new Error("ServiceNow field mapping is invalid"), { code: "SERVICENOW_WRITE_MAPPING_INVALID" });
  }
  return value;
}

export function validateServiceNowWriteFieldMapping(commandType: ServiceNowWriteCommandType, mapping: unknown) {
  serviceNowWriteCommandTypeSchema.parse(commandType);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw Object.assign(new Error("ServiceNow field mapping is invalid"), { code: "SERVICENOW_WRITE_MAPPING_INVALID" });
  }
  const entries = Object.entries(mapping);
  if (entries.length > 30) throw Object.assign(new Error("ServiceNow field mapping is too large"), { code: "SERVICENOW_WRITE_MAPPING_INVALID" });
  const result: ServiceNowWriteFieldMapping = {};
  for (const [source, target] of entries) {
    if (!allowedSourceFields[commandType].has(source) || typeof target !== "string") {
      throw Object.assign(new Error("ServiceNow field mapping is invalid"), { code: "SERVICENOW_WRITE_MAPPING_INVALID" });
    }
    result[source] = validateTargetField(target);
  }
  return result;
}

export function serviceNowDefaultWriteMapping(commandType: ServiceNowWriteCommandType) {
  return { ...defaultMappings[commandType] };
}

function sourceFields(input: ServiceNowWriteCommandInput) {
  if (input.commandType === "create_incident") {
    return Object.fromEntries(Object.entries(input.payload).filter(([key]) => key !== "externalReferences"));
  }
  if (input.commandType === "update_incident") {
    return Object.fromEntries(Object.entries(input.payload).filter(([key]) => key !== "sysId" && key !== "number"));
  }
  return { text: input.payload.text };
}

export function normalizeCommand(
  input: ServiceNowWriteCommandInput,
  configuredMapping?: ServiceNowWriteFieldMapping,
): NormalizedServiceNowWriteCommand {
  const mapping = configuredMapping
    ? validateServiceNowWriteFieldMapping(input.commandType, configuredMapping)
    : defaultMappings[input.commandType];
  const fields: Record<string, string> = {};
  for (const [source, value] of Object.entries(sourceFields(input))) {
    const target = mapping[source];
    if (!target || typeof value !== "string" || !value) continue;
    fields[target] = value;
  }
  if (!Object.keys(fields).length) {
    throw Object.assign(new Error("No mapped ServiceNow fields remain after normalization"), { code: "SERVICENOW_WRITE_EMPTY_MAPPING" });
  }
  return {
    commandType: input.commandType,
    ...(input.commandType !== "create_incident" && input.payload.sysId ? { targetSysId: input.payload.sysId } : {}),
    ...(input.commandType !== "create_incident" && input.payload.number ? { targetNumber: input.payload.number } : {}),
    fields,
  };
}

const enumFields = new Set(["impact", "urgency", "state"]);
const identifierFields = new Set(["caller_id", "assignment_group", "company", "correlation_id", "u_project_code"]);

export function buildServiceNowWritePreview(normalized: NormalizedServiceNowWriteCommand): ServiceNowWritePreview {
  return {
    commandType: normalized.commandType,
    targetSysId: normalized.targetSysId,
    targetNumber: normalized.targetNumber,
    fields: Object.entries(normalized.fields).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({
      name,
      kind: enumFields.has(name) ? "enum" as const : identifierFields.has(name) ? "identifier" as const : "text" as const,
      length: value.length,
      ...(enumFields.has(name) || identifierFields.has(name) ? { value } : {}),
    })),
  };
}
