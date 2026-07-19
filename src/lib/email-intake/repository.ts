import {
  IntegrationBoundaryError,
  externalMessageIdSchema,
  integrationProviderSchema,
  type IntegrationCorrelationId,
  type IntegrationProvider,
} from "../integrations";
import {
  EmailIntakeAggregate,
  type EmailIntakeActionContext,
  type EmailIntakeMutationResult,
} from "./aggregate";
import { DuplicateEmailIntake, EmailIntakeNotFound } from "./errors";
import {
  emailIntakeExistsQuerySchema,
  emailIntakeIdSchema,
  emailIntakeRecordSchema,
  emailIntakeSearchSchema,
  emailIntakeStatusSchema,
  type EmailIntakeExistsQuery,
  type EmailIntakeRecord,
  type EmailIntakeSearch,
  type EmailIntakeStatus,
  type NormalizedEmailIntakeSearch,
} from "./schemas";

export type EmailIntakeSearchResult = Readonly<{
  items: readonly EmailIntakeAggregate[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>;

export interface EmailIntakeRepository {
  create(aggregate: EmailIntakeAggregate): Promise<EmailIntakeAggregate>;
  update(aggregate: EmailIntakeAggregate): Promise<EmailIntakeAggregate>;
  exists(query: EmailIntakeExistsQuery): Promise<boolean>;
  findById(intakeId: string): Promise<EmailIntakeAggregate | undefined>;
  findByExternalMessageId(provider: IntegrationProvider, externalMessageId: string): Promise<EmailIntakeAggregate | undefined>;
  search(query?: EmailIntakeSearch): Promise<EmailIntakeSearchResult>;
  list(): Promise<readonly EmailIntakeAggregate[]>;
  changeStatus(intakeId: string, status: EmailIntakeStatus, context: EmailIntakeActionContext): Promise<EmailIntakeMutationResult>;
  deleteForTestsOnly(intakeId: string, correlationId: IntegrationCorrelationId): Promise<boolean>;
}

export interface EmailIntakePersistence {
  list(): Promise<EmailIntakeRecord[]>;
  insert(record: EmailIntakeRecord): Promise<boolean>;
  replace(record: EmailIntakeRecord): Promise<boolean>;
  remove(record: EmailIntakeRecord): Promise<boolean>;
}

export type EmailIntakeRepositoryOptions = Readonly<{
  allowTestDelete?: boolean;
}>;

export function recordsShareIdentity(left: EmailIntakeRecord, right: EmailIntakeRecord) {
  return left.intakeId === right.intakeId
    || left.idempotencyKey === right.idempotencyKey
    || (left.provider === right.provider && left.externalMessageId === right.externalMessageId);
}

function stringSortValue(record: EmailIntakeRecord, sortBy: NormalizedEmailIntakeSearch["sortBy"]) {
  switch (sortBy) {
    case "sender": return record.sender.address;
    case "subject": return record.subject ?? "";
    case "status": return record.currentStatus;
    case "provider": return record.provider;
    default: return record[sortBy];
  }
}

export function searchEmailIntakeRecords(
  records: readonly EmailIntakeRecord[],
  input: EmailIntakeSearch = {},
) {
  const query = emailIntakeSearchSchema.parse(input);
  const sender = query.sender?.toLowerCase();
  const subject = query.subject?.toLowerCase();
  const filtered = records.filter((record) => {
    if (query.status && record.currentStatus !== query.status) return false;
    if (query.provider && record.provider !== query.provider) return false;
    if (sender && !record.sender.address.toLowerCase().includes(sender)) return false;
    if (subject && !(record.subject ?? "").toLowerCase().includes(subject)) return false;
    if (query.receivedFrom && record.receivedAt < query.receivedFrom) return false;
    if (query.receivedTo && record.receivedAt > query.receivedTo) return false;
    if (query.correlationId && record.correlationId !== query.correlationId) return false;
    return true;
  });
  filtered.sort((left, right) => {
    const leftValue = stringSortValue(left, query.sortBy);
    const rightValue = stringSortValue(right, query.sortBy);
    const compared = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    const ordered = compared || (left.intakeId < right.intakeId ? -1 : left.intakeId > right.intakeId ? 1 : 0);
    return query.sortDirection === "asc" ? ordered : -ordered;
  });
  const offset = (query.page - 1) * query.pageSize;
  return {
    records: filtered.slice(offset, offset + query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: filtered.length ? Math.ceil(filtered.length / query.pageSize) : 0,
  } as const;
}

function notFound(correlationId: IntegrationCorrelationId) {
  return new EmailIntakeNotFound({ correlationId });
}

function assertIdentityIsStable(current: EmailIntakeRecord, next: EmailIntakeRecord) {
  if (
    current.intakeId !== next.intakeId
    || current.provider !== next.provider
    || current.externalMessageId !== next.externalMessageId
    || current.idempotencyKey !== next.idempotencyKey
    || current.correlationId !== next.correlationId
  ) {
    throw new IntegrationBoundaryError({
      category: "conflict",
      code: "EMAIL_INTAKE_IDENTITY_IMMUTABLE",
      safeMessage: "Email intake identity fields cannot be changed",
      retryable: false,
      provider: current.provider,
      operation: "event.handle",
      correlationId: current.correlationId,
    });
  }
}

export function createEmailIntakeRepository(
  persistence: EmailIntakePersistence,
  options: EmailIntakeRepositoryOptions = {},
): EmailIntakeRepository {
  async function validatedRecords() {
    return (await persistence.list()).map((record) => emailIntakeRecordSchema.parse(record));
  }

  const repository: EmailIntakeRepository = {
    async create(aggregate) {
      const record = emailIntakeRecordSchema.parse(aggregate.toRecord());
      if (!await persistence.insert(record)) {
        throw new DuplicateEmailIntake({
          provider: record.provider,
          correlationId: record.correlationId,
        });
      }
      return EmailIntakeAggregate.rehydrate(record);
    },

    async update(aggregate) {
      const record = emailIntakeRecordSchema.parse(aggregate.toRecord());
      const current = (await validatedRecords()).find((item) => item.intakeId === record.intakeId);
      if (!current) throw notFound(record.correlationId);
      assertIdentityIsStable(current, record);
      if (!await persistence.replace(record)) throw notFound(record.correlationId);
      return EmailIntakeAggregate.rehydrate(record);
    },

    async exists(input) {
      const query = emailIntakeExistsQuerySchema.parse(input);
      return (await validatedRecords()).some((record) =>
        (query.intakeId !== undefined && record.intakeId === query.intakeId)
        || (query.idempotencyKey !== undefined && record.idempotencyKey === query.idempotencyKey)
        || (query.provider !== undefined && record.provider === query.provider && record.externalMessageId === query.externalMessageId));
    },

    async findById(intakeId) {
      const normalizedId = emailIntakeIdSchema.parse(intakeId);
      const record = (await validatedRecords()).find((item) => item.intakeId === normalizedId);
      return record ? EmailIntakeAggregate.rehydrate(record) : undefined;
    },

    async findByExternalMessageId(provider, externalMessageId) {
      const normalizedProvider = integrationProviderSchema.parse(provider);
      const normalizedExternalId = externalMessageIdSchema.parse(externalMessageId);
      const record = (await validatedRecords()).find((item) => item.provider === normalizedProvider && item.externalMessageId === normalizedExternalId);
      return record ? EmailIntakeAggregate.rehydrate(record) : undefined;
    },

    async search(input = {}) {
      const result = searchEmailIntakeRecords(await validatedRecords(), input);
      return Object.freeze({
        items: Object.freeze(result.records.map((record) => EmailIntakeAggregate.rehydrate(record))),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      });
    },

    async list() {
      const records = (await validatedRecords()).sort((left, right) => {
        const compared = left.receivedAt < right.receivedAt ? 1 : left.receivedAt > right.receivedAt ? -1 : 0;
        return compared || (left.intakeId < right.intakeId ? 1 : left.intakeId > right.intakeId ? -1 : 0);
      });
      return Object.freeze(records.map((record) => EmailIntakeAggregate.rehydrate(record)));
    },

    async changeStatus(intakeId, status, context) {
      const normalizedId = emailIntakeIdSchema.parse(intakeId);
      const normalizedStatus = emailIntakeStatusSchema.parse(status);
      const record = (await validatedRecords()).find((item) => item.intakeId === normalizedId);
      if (!record) throw notFound(context.correlationId);
      const aggregate = EmailIntakeAggregate.rehydrate(record);
      const result = aggregate.transitionTo(normalizedStatus, context);
      const updatedRecord = emailIntakeRecordSchema.parse(result.aggregate.toRecord());
      assertIdentityIsStable(record, updatedRecord);
      if (!await persistence.replace(updatedRecord)) throw notFound(context.correlationId);
      return result;
    },

    async deleteForTestsOnly(intakeId, correlationId) {
      if (!options.allowTestDelete) {
        throw new IntegrationBoundaryError({
          category: "unsupported",
          code: "EMAIL_INTAKE_TEST_DELETE_DISABLED",
          safeMessage: "Email intake test deletion is disabled",
          retryable: false,
          provider: "internal",
          operation: "event.handle",
          correlationId,
        });
      }
      const normalizedId = emailIntakeIdSchema.parse(intakeId);
      const record = (await validatedRecords()).find((item) => item.intakeId === normalizedId);
      return record ? persistence.remove(record) : false;
    },
  };
  return Object.freeze(repository);
}
