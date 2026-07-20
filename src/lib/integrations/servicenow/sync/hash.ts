import { createHash } from "node:crypto";
import type { NormalizedServiceNowIncident } from "../schemas";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

export function serviceNowSourceFields(incident: NormalizedServiceNowIncident) {
  return {
    externalSysId: incident.externalSysId,
    number: incident.number,
    title: incident.title,
    description: incident.description,
    state: incident.state,
    stateValue: incident.stateValue,
    priority: incident.priority,
    priorityValue: incident.priorityValue,
    impact: incident.impact,
    urgency: incident.urgency,
    customerReference: incident.customerReference,
    customerExternalId: incident.customerExternalId,
    callerReference: incident.callerReference,
    assignedUserReference: incident.assignedUserReference,
    assignmentGroupReference: incident.assignmentGroupReference,
    category: incident.category,
    subcategory: incident.subcategory,
    openedAt: incident.openedAt,
    resolvedAt: incident.resolvedAt,
    closedAt: incident.closedAt,
    createdAt: incident.createdAt,
    lastUpdatedAt: incident.lastUpdatedAt,
    externalUrl: incident.externalUrl,
  };
}

export function hashServiceNowIncident(incident: NormalizedServiceNowIncident) {
  return createHash("sha256").update(stable(serviceNowSourceFields(incident))).digest("hex");
}
