import { describe, expect, it } from "vitest";
import { deriveServiceNowCustomerIdentity, serviceNowCustomerIdentityFromTicket, serviceNowUnknownCustomerKey } from "./customer-identity";

describe("ServiceNow customer identity", () => {
  it("uses a lowercase sys_id and ignores display-name changes", () => {
    const first = deriveServiceNowCustomerIdentity({ externalCustomerId: "ABCDEF0123456789ABCDEF0123456789", externalCustomerName: "Old name" });
    const renamed = deriveServiceNowCustomerIdentity({ externalCustomerId: "ABCDEF0123456789ABCDEF0123456789", externalCustomerName: "New name" });
    expect(first.externalCustomerKey).toBe("servicenow-unmapped:abcdef0123456789abcdef0123456789");
    expect(renamed.externalCustomerKey).toBe(first.externalCustomerKey);
  });

  it("hashes non-sys-id references deterministically", () => {
    const first = deriveServiceNowCustomerIdentity({ externalCustomerId: "legacy-company-reference" });
    expect(first.externalCustomerKey).toBe("servicenow-unmapped:ref-015e4c36608f0e88de389e10");
    expect(deriveServiceNowCustomerIdentity({ externalCustomerId: "legacy-company-reference" }).externalCustomerKey).toBe(first.externalCustomerKey);
  });

  it("marks the missing-company fallback as non-mappable", () => {
    expect(deriveServiceNowCustomerIdentity({})).toMatchObject({ externalCustomerKey: serviceNowUnknownCustomerKey, mappable: false });
  });

  it("uses the same compatibility order for ticket aggregation", () => {
    const identity = serviceNowCustomerIdentityFromTicket({ customerKey: "confirmed", customerName: "Confirmed", serviceNow: { companyExternalId: "legacy-company-reference", companyReference: "Legacy" } });
    expect(identity).toEqual(deriveServiceNowCustomerIdentity({ externalCustomerId: "legacy-company-reference", externalCustomerName: "Legacy" }));
  });
});
