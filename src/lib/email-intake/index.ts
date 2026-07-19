export {
  EmailIntakeAggregate,
  allowedEmailIntakeTransitions,
  type EmailIntakeActionContext,
  type EmailIntakeDomainDependencies,
  type EmailIntakeMutationResult,
  type EmailIntakeRevision,
} from "./aggregate";
export { DuplicateEmailIntake, EmailIntakeNotFound, InvalidStatusTransition } from "./errors";
export { emailIntakeEventTypes, type EmailIntakeDomainEvent, type EmailIntakeEventType } from "./events";
export { createJsonEmailIntakeRepository, type EmailIntakeJsonStore } from "./json-repository";
export { createRelationalEmailIntakeRepository, type EmailIntakeRelationalStore } from "./relational-repository";
export { createEmailIntakeRepositoryForBackend, getEmailIntakeRepository } from "./repository-factory";
export {
  createEmailIntakeRepository,
  searchEmailIntakeRecords,
  type EmailIntakePersistence,
  type EmailIntakeRepository,
  type EmailIntakeSearchResult,
} from "./repository";
export {
  emailIntakeRecordSchema,
  emailIntakeSearchSchema,
  emailIntakeStatuses,
  emailIntakeStatusSchema,
  type EmailIntakeAuditEntry,
  type EmailIntakeExistsQuery,
  type EmailIntakeRecord,
  type EmailIntakeSearch,
  type EmailIntakeStatus,
} from "./schemas";
