import { emailIntakeRecordListSchema, emailIntakeRecordSchema, type EmailIntakeRecord } from "./schemas";
import { createEmailIntakeRepository, type EmailIntakeRepositoryOptions } from "./repository";

export interface EmailIntakeRelationalStore {
  list(): Promise<unknown[]>;
  insert(record: EmailIntakeRecord): Promise<boolean>;
  replace(record: EmailIntakeRecord): Promise<boolean>;
  remove(record: EmailIntakeRecord): Promise<boolean>;
}

export function createRelationalEmailIntakeRepository(
  store: EmailIntakeRelationalStore,
  options: EmailIntakeRepositoryOptions = {},
) {
  return createEmailIntakeRepository({
    list: async () => emailIntakeRecordListSchema.parse(await store.list()),
    insert: (record) => store.insert(emailIntakeRecordSchema.parse(record)),
    replace: (record) => store.replace(emailIntakeRecordSchema.parse(record)),
    remove: (record) => store.remove(emailIntakeRecordSchema.parse(record)),
  }, options);
}
