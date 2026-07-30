import { serviceNowCorrelationMarkerSchema, serviceNowWriteCommandTypeSchema } from "./schemas";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteCommandInput,
  ServiceNowWriteCommandType,
  ServiceNowWritePreview,
} from "./types";

export type ServiceNowWriteFieldMapping = Record<string, string>;

const reservedCorrelationField = "correlation_id";
const approvedMappings: Record<ServiceNowWriteCommandType, Readonly<Record<string, string>>> = {
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

function invalidMapping(): never {
  throw Object.assign(new Error("ServiceNow field mapping is outside the reviewed allowlist"), {
    code: "SERVICENOW_WRITE_MAPPING_INVALID",
  });
}

export function validateServiceNowWriteFieldMapping(
  commandType: ServiceNowWriteCommandType,
  mapping: unknown,
) {
  serviceNowWriteCommandTypeSchema.parse(commandType);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) invalidMapping();
  const approved = approvedMappings[commandType];
  const entries = Object.entries(mapping);
  if (entries.length !== Object.keys(approved).length) invalidMapping();
  const targetFields = new Set<string>();
  const result: ServiceNowWriteFieldMapping = {};
  for (const [source, target] of entries) {
    if (typeof target !== "string"
      || approved[source] !== target
      || target === reservedCorrelationField
      || targetFields.has(target)) {
      invalidMapping();
    }
    targetFields.add(target);
    result[source] = target;
  }
  for (const requiredSource of Object.keys(approved)) {
    if (!Object.hasOwn(result, requiredSource)) invalidMapping();
  }
  return result;
}

export function serviceNowDefaultWriteMapping(commandType: ServiceNowWriteCommandType) {
  return { ...approvedMappings[commandType] };
}

function sourceFields(input: ServiceNowWriteCommandInput) {
  if (input.commandType === "create_incident") {
    return Object.fromEntries(Object.entries(input.payload).filter(([key]) => (
      key !== "externalReferences" && key !== "supperTicketNo"
    )));
  }
  if (input.commandType === "update_incident") {
    return Object.fromEntries(Object.entries(input.payload).filter(([key]) => key !== "sysId" && key !== "number"));
  }
  return { text: input.payload.text };
}

export function normalizeCommand(
  input: ServiceNowWriteCommandInput,
  configuredMapping: ServiceNowWriteFieldMapping,
  providerCorrelationMarker?: string,
): NormalizedServiceNowWriteCommand {
  const mapping = validateServiceNowWriteFieldMapping(input.commandType, configuredMapping);
  const fields: Record<string, string> = {};
  for (const [source, value] of Object.entries(sourceFields(input))) {
    const target = mapping[source];
    if (!target || typeof value !== "string" || !value) continue;
    fields[target] = value;
  }
  if (input.commandType === "create_incident") {
    const marker = serviceNowCorrelationMarkerSchema.parse(providerCorrelationMarker);
    fields[reservedCorrelationField] = marker;
  }
  if (!Object.keys(fields).length) {
    throw Object.assign(new Error("No mapped ServiceNow fields remain after normalization"), {
      code: "SERVICENOW_WRITE_EMPTY_MAPPING",
    });
  }
  return {
    schemaVersion: "servicenow-write-normalized-v2",
    commandType: input.commandType,
    ...(input.commandType !== "create_incident" && input.payload.sysId ? { targetSysId: input.payload.sysId } : {}),
    ...(input.commandType !== "create_incident" && input.payload.number ? { targetNumber: input.payload.number } : {}),
    ...(input.commandType === "create_incident" ? { providerCorrelationMarker } : {}),
    fields,
  };
}

const enumFields = new Set(["impact", "urgency", "state"]);
const identifierFields = new Set(["caller_id", "assignment_group", "company", "correlation_id"]);

export function buildServiceNowWritePreview(normalized: NormalizedServiceNowWriteCommand): ServiceNowWritePreview {
  return {
    commandType: normalized.commandType,
    targetSysId: normalized.targetSysId,
    targetNumber: normalized.targetNumber,
    providerCorrelationMarker: normalized.providerCorrelationMarker,
    fields: Object.entries(normalized.fields).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({
      name,
      kind: enumFields.has(name) ? "enum" as const : identifierFields.has(name) ? "identifier" as const : "text" as const,
      length: value.length,
      ...(enumFields.has(name) || identifierFields.has(name) ? { value } : {}),
    })),
  };
}
