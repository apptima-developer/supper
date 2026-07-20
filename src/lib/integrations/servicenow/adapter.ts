import type { IntegrationCorrelationId } from "../contracts";
import type { ServiceNowConfig } from "./config";
import { serviceNowError } from "./errors";
import { ServiceNowReadClient, type ServiceNowListInput } from "./client";

export class ServiceNowReadOnlyAdapter {
  readonly provider = "servicenow" as const;

  constructor(
    private readonly config: ServiceNowConfig,
    private readonly dependencies: { fetch: typeof fetch; now?: () => number; maxPages?: number } = { fetch },
  ) {}

  private client(correlationId: IntegrationCorrelationId) {
    if (!this.config.enabled) throw serviceNowError({ category: "unsupported", code: "SERVICENOW_DISABLED", safeMessage: "ServiceNow integration is disabled", retryable: false, operation: "provider.test", correlationId });
    return new ServiceNowReadClient(this.config, this.dependencies);
  }

  async testConnection(correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const startedAt = this.dependencies.now?.() ?? Date.now();
    const resultCount = await this.client(correlationId).testConnection(correlationId, signal);
    const finishedAt = this.dependencies.now?.() ?? Date.now();
    return { provider: this.provider, connected: true, resultCount, durationMs: Math.max(0, finishedAt - startedAt) };
  }

  listIncidents(input: ServiceNowListInput, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    return this.client(correlationId).listIncidents(input, correlationId, signal);
  }

  getIncidentBySysId(sysId: string, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    return this.client(correlationId).getIncidentBySysId(sysId, correlationId, signal);
  }
}
