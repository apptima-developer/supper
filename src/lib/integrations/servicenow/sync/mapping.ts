import type { Ticket } from "../../../types";
import { deriveServiceNowCustomerIdentity } from "../customer-identity";
import type { NormalizedServiceNowIncident } from "../schemas";
import { hashServiceNowIncident } from "./hash";

export type ServiceNowMappingWarning =
  | "UNKNOWN_PRIORITY"
  | "MISSING_PRIORITY"
  | "UNKNOWN_STATE"
  | "MISSING_STATE"
  | "MISSING_COMPANY"
  | "DESCRIPTION_TRUNCATED";

export type MappedServiceNowIncident = {
  ticket: Ticket;
  sourceHash: string;
  externalUpdatedAt: string;
  linkMetadata: { requiresCustomerMapping: boolean; mappingWarnings: ServiceNowMappingWarning[] };
};

function normalizedToken(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim().toLowerCase() || "";
}

export function mapServiceNowPriority(priorityValue?: string, priorityDisplay?: string) {
  const token = normalizedToken(priorityValue, priorityDisplay);
  if (token === "1" || token.includes("critical")) return { severity: "Critical", warning: undefined };
  if (token === "2" || token.includes("high")) return { severity: "High", warning: undefined };
  if (token === "3" || token.includes("moderate") || token.includes("medium")) return { severity: "Medium", warning: undefined };
  if (["4", "5"].includes(token) || token.includes("low") || token.includes("planning")) return { severity: "Low", warning: undefined };
  return { severity: "Medium", warning: (token ? "UNKNOWN_PRIORITY" : "MISSING_PRIORITY") as ServiceNowMappingWarning };
}

export function mapServiceNowState(stateValue?: string, stateDisplay?: string) {
  const token = normalizedToken(stateValue, stateDisplay).replace(/[_-]+/g, " ");
  if (token === "1" || token === "new") return { status: "00 - Open", kanbanStatus: "open" as const, warning: undefined };
  if (token === "2" || token === "in progress") return { status: "04 - Func Inprogress", kanbanStatus: "in_progress" as const, warning: undefined };
  if (token === "3" || token === "on hold" || token === "pending") return { status: "07 - Waiting user", kanbanStatus: "waiting" as const, warning: undefined };
  if (token === "6" || token === "resolved") return { status: "08 - Resolved", kanbanStatus: "resolved" as const, warning: undefined };
  if (token === "7" || token === "closed") return { status: "02 - Closed", kanbanStatus: "closed" as const, warning: undefined };
  if (["8", "cancelled", "canceled"].includes(token)) return { status: "01 - Cancel", kanbanStatus: "cancelled" as const, warning: undefined };
  return { status: "00 - Open", kanbanStatus: "open" as const, warning: (token ? "UNKNOWN_STATE" : "MISSING_STATE") as ServiceNowMappingWarning };
}

export function mapServiceNowIncidentToTicket(
  incident: NormalizedServiceNowIncident,
  options: { ticketId: string; now: string },
): MappedServiceNowIncident {
  if (!incident.lastUpdatedAt) throw new Error("ServiceNow Incident is missing sys_updated_on");
  const priority = mapServiceNowPriority(incident.priorityValue, incident.priority);
  const state = mapServiceNowState(incident.stateValue, incident.state);
  const warnings = [priority.warning, state.warning, incident.customerExternalId ? undefined : "MISSING_COMPANY"]
    .filter((value): value is ServiceNowMappingWarning => Boolean(value));
  if (incident.description && incident.description.length > 4_000) warnings.push("DESCRIPTION_TRUNCATED");
  const customerIdentity = deriveServiceNowCustomerIdentity({
    externalCustomerId: incident.customerExternalId,
    externalCustomerName: incident.customerReference,
  });
  const customerKey = customerIdentity.externalCustomerKey;
  const customerName = customerIdentity.externalCustomerName;
  const sourceHash = hashServiceNowIncident(incident);
  const createdAt = incident.createdAt || incident.openedAt || incident.lastUpdatedAt;
  const openedAt = incident.openedAt || createdAt;
  const closedAt = incident.closedAt || incident.resolvedAt || "";

  return {
    sourceHash,
    externalUpdatedAt: incident.lastUpdatedAt,
    linkMetadata: { requiresCustomerMapping: true, mappingWarnings: warnings },
    ticket: {
      id: options.ticketId,
      issueId: incident.number,
      date: createdAt,
      customerKey,
      customerName,
      issueTitle: incident.title,
      issueType: "Incident",
      category: incident.category || "",
      severity: priority.severity,
      owner: "",
      ownerEfforts: [],
      status: state.status,
      kanbanStatus: state.kanbanStatus,
      startDate: openedAt,
      dueDate: "",
      closeDate: closedAt,
      mdUsed: 0,
      chargeable: false,
      remark: "",
      ticketLogs: [],
      slaPauses: [],
      requiresCustomerMapping: true,
      serviceNow: {
        provider: "servicenow",
        externalSysId: incident.externalSysId,
        externalNumber: incident.number,
        externalUrl: incident.externalUrl,
        description: incident.description?.slice(0, 4_000),
        rawState: incident.state,
        rawStateValue: incident.stateValue,
        rawPriority: incident.priority,
        rawPriorityValue: incident.priorityValue,
        impact: incident.impact,
        urgency: incident.urgency,
        subcategory: incident.subcategory,
        companyReference: incident.customerReference,
        companyExternalId: incident.customerExternalId,
        externalCustomerKey: customerIdentity.externalCustomerKey,
        externalCustomerId: customerIdentity.externalCustomerId,
        externalCustomerName: customerIdentity.externalCustomerName,
        callerReference: incident.callerReference,
        assignedUserReference: incident.assignedUserReference,
        assignmentGroupReference: incident.assignmentGroupReference,
        openedAt: incident.openedAt,
        externalCreatedAt: incident.createdAt,
        resolvedAt: incident.resolvedAt,
        closedAt: incident.closedAt,
        externalUpdatedAt: incident.lastUpdatedAt,
        sourceHash,
        mappingWarnings: warnings,
      },
      createdAt,
      updatedAt: options.now,
    },
  };
}

export type ExistingExternalLink = { externalUpdatedAt: string; sourceHash: string };

export function mergeServiceNowIncidentIntoTicket<TicketWithExtensions extends Ticket & Record<string, unknown>>(
  existing: TicketWithExtensions,
  incoming: MappedServiceNowIncident,
  link: ExistingExternalLink,
) {
  const sourceTime = new Date(incoming.externalUpdatedAt).getTime();
  const storedTime = new Date(link.externalUpdatedAt).getTime();
  if (sourceTime < storedTime) return { outcome: "stale" as const, ticket: existing };
  if (incoming.sourceHash === link.sourceHash) return { outcome: "unchanged" as const, ticket: existing };

  const preserveCustomer = !existing.customerKey.startsWith("servicenow-unmapped:");
  const source = incoming.ticket;
  const ticket = {
    ...existing,
    issueId: source.issueId,
    customerKey: preserveCustomer ? existing.customerKey : source.customerKey,
    customerName: preserveCustomer ? existing.customerName : source.customerName,
    issueTitle: source.issueTitle,
    issueType: "Incident",
    category: source.category,
    severity: source.severity,
    status: source.status,
    kanbanStatus: source.kanbanStatus,
    date: source.date,
    startDate: source.startDate,
    closeDate: source.closeDate,
    serviceNow: source.serviceNow,
    requiresCustomerMapping: preserveCustomer ? false : true,
    updatedAt: source.updatedAt,
  } as TicketWithExtensions;
  return {
    outcome: "updated" as const,
    ticket,
    warningCode: sourceTime === storedTime ? "SAME_TIMESTAMP_CHANGED" as const : undefined,
  };
}
