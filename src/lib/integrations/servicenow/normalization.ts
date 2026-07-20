import { normalizedServiceNowIncidentSchema, type NormalizedServiceNowIncident } from "./schemas";
import type { ServiceNowEnabledConfig } from "./config";

type RawRecord = Record<string, unknown>;

function primitive(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function normalizeServiceNowField(value: unknown, preferDisplay = false) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const preferred = preferDisplay ? record.display_value : record.value;
    const fallback = preferDisplay ? record.value : record.display_value;
    return primitive(preferred) || primitive(fallback);
  }
  return primitive(value);
}

function optional(value: string) {
  return value || undefined;
}

function timestamp(value: unknown) {
  const raw = normalizeServiceNowField(value);
  if (!raw) return undefined;
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const date = new Date(isoLike);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function normalizeServiceNowIncident(record: RawRecord, config: ServiceNowEnabledConfig): NormalizedServiceNowIncident {
  const externalSysId = normalizeServiceNowField(record.sys_id);
  const number = normalizeServiceNowField(record.number, true);
  const title = normalizeServiceNowField(record.short_description, true) || number;
  const incidentPath = `incident.do?sys_id=${encodeURIComponent(externalSysId)}`;
  const externalUrl = `${config.instanceUrl}/nav_to.do?uri=${encodeURIComponent(incidentPath)}`;
  return normalizedServiceNowIncidentSchema.parse({
    provider: "servicenow",
    externalSysId,
    number,
    externalUrl,
    title,
    description: optional(normalizeServiceNowField(record.description, true)),
    state: optional(normalizeServiceNowField(record.state, true)),
    priority: optional(normalizeServiceNowField(record.priority, true)),
    impact: optional(normalizeServiceNowField(record.impact, true)),
    urgency: optional(normalizeServiceNowField(record.urgency, true)),
    customerReference: optional(normalizeServiceNowField(record.company, true)),
    callerReference: optional(normalizeServiceNowField(record.caller_id, true)),
    assignedUserReference: optional(normalizeServiceNowField(record.assigned_to, true)),
    assignmentGroupReference: optional(normalizeServiceNowField(record.assignment_group, true)),
    category: optional(normalizeServiceNowField(record.category, true)),
    subcategory: optional(normalizeServiceNowField(record.subcategory, true)),
    openedAt: timestamp(record.opened_at),
    resolvedAt: timestamp(record.resolved_at),
    closedAt: timestamp(record.closed_at),
    createdAt: timestamp(record.sys_created_on),
    lastUpdatedAt: timestamp(record.sys_updated_on),
    providerMetadata: { table: config.incidentTable },
  });
}
