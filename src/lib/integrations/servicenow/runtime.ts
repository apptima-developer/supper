import "server-only";
import { parseServiceNowConfig, summarizeServiceNowConfig } from "./config";
import { ServiceNowReadOnlyAdapter } from "./adapter";

export function getServiceNowConfigSummary() {
  return summarizeServiceNowConfig(process.env);
}

export function getServiceNowAdapter() {
  return new ServiceNowReadOnlyAdapter(parseServiceNowConfig(process.env), { fetch });
}
