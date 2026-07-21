export type SafeServiceNowValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type SafeServiceNowRuntimeDiagnostics = {
  deployment: {
    appEnvironment?: string;
    vercelEnvironment?: string;
    gitBranch?: string;
    commitSha?: string;
    deploymentHost?: string;
  };
  serviceNow: {
    enabledVariablePresent: boolean;
    enabledNormalized: boolean | null;
    instanceUrlPresent: boolean;
    instanceHostname?: string;
    instanceUrlValid: boolean;
    authModePresent: boolean;
    authModeNormalized: "basic" | "oauth_client_credentials" | null;
    usernamePresent: boolean;
    usernameNonEmptyAfterTrim: boolean;
    passwordPresent: boolean;
    passwordNonEmpty: boolean;
    clientIdPresent: boolean;
    clientIdNonEmptyAfterTrim: boolean;
    clientSecretPresent: boolean;
    clientSecretNonEmpty: boolean;
    timeoutPresent: boolean;
    timeoutValid: boolean;
    pageSizePresent: boolean;
    pageSizeValid: boolean;
    incidentTablePresent: boolean;
    incidentTableValid: boolean;
    configurationValid: boolean;
    validationIssues: SafeServiceNowValidationIssue[];
  };
  synchronization: {
    enabledVariablePresent: boolean;
    enabledNormalized: boolean | null;
    configurationValid: boolean;
    validationIssues: SafeServiceNowValidationIssue[];
  };
};
