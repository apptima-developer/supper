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
export {
  type EmailIntakeRepository,
  type EmailIntakeSearchResult,
} from "./repository";
export {
  emailIntakeSearchSchema,
  emailIntakeStatuses,
  emailIntakeStatusSchema,
  type EmailIntakeExistsQuery,
  type EmailIntakeSearch,
  type EmailIntakeStatus,
} from "./schemas";
