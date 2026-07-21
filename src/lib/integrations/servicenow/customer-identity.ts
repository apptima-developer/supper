import { createHash } from "node:crypto";

export const serviceNowUnknownCustomerKey = "servicenow-unmapped:unknown";

export type ServiceNowCustomerIdentity = {
  provider: "servicenow";
  externalCustomerKey: string;
  externalCustomerId?: string;
  externalCustomerName: string;
  mappable: boolean;
};

function bounded(value: string | undefined, maximum: number) {
  const text = value?.trim() || "";
  return text ? text.slice(0, maximum) : undefined;
}

function boundedExternalKey(value: string | undefined) {
  const key = bounded(value, 600);
  return key && /^servicenow-unmapped:[a-z0-9-]+$/.test(key) ? key : undefined;
}

export function deriveServiceNowCustomerIdentity(input: {
  externalCustomerId?: string;
  externalCustomerName?: string;
}): ServiceNowCustomerIdentity {
  const rawId = bounded(input.externalCustomerId, 500);
  const externalCustomerName = bounded(input.externalCustomerName, 500) || "Unmapped ServiceNow customer";
  if (!rawId) {
    return {
      provider: "servicenow",
      externalCustomerKey: serviceNowUnknownCustomerKey,
      externalCustomerName,
      mappable: false,
    };
  }

  const stableId = /^[a-f0-9]{32}$/i.test(rawId)
    ? rawId.toLowerCase()
    : `ref-${createHash("sha256").update(rawId).digest("hex").slice(0, 24)}`;

  return {
    provider: "servicenow",
    externalCustomerKey: `servicenow-unmapped:${stableId}`,
    externalCustomerId: rawId,
    externalCustomerName,
    mappable: true,
  };
}

export function serviceNowCustomerIdentityFromTicket(ticket: {
  customerKey?: string;
  customerName?: string;
  serviceNow?: {
    externalCustomerKey?: string;
    externalCustomerId?: string;
    externalCustomerName?: string;
    companyExternalId?: string;
    companyReference?: string;
  };
}): ServiceNowCustomerIdentity {
  const metadataKey = boundedExternalKey(ticket.serviceNow?.externalCustomerKey);
  if (metadataKey) {
    return {
      provider: "servicenow",
      externalCustomerKey: metadataKey,
      externalCustomerId: bounded(ticket.serviceNow?.externalCustomerId || ticket.serviceNow?.companyExternalId, 500),
      externalCustomerName: bounded(ticket.serviceNow?.externalCustomerName || ticket.serviceNow?.companyReference || ticket.customerName, 500) || "Unmapped ServiceNow customer",
      mappable: metadataKey !== serviceNowUnknownCustomerKey,
    };
  }
  const currentCustomerKey = boundedExternalKey(ticket.customerKey);
  if (currentCustomerKey) {
    return {
      provider: "servicenow",
      externalCustomerKey: currentCustomerKey,
      externalCustomerId: bounded(ticket.serviceNow?.externalCustomerId || ticket.serviceNow?.companyExternalId, 500),
      externalCustomerName: bounded(ticket.serviceNow?.externalCustomerName || ticket.serviceNow?.companyReference || ticket.customerName, 500) || "Unmapped ServiceNow customer",
      mappable: currentCustomerKey !== serviceNowUnknownCustomerKey,
    };
  }
  return deriveServiceNowCustomerIdentity({
    externalCustomerId: ticket.serviceNow?.externalCustomerId || ticket.serviceNow?.companyExternalId,
    externalCustomerName: ticket.serviceNow?.externalCustomerName || ticket.serviceNow?.companyReference || ticket.customerName,
  });
}
