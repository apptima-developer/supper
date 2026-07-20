export class ServiceNowSyncUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceNowSyncUnavailableError";
    this.code = code;
  }
}
