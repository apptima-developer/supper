import { emailIntakeRecordListSchema, type EmailIntakeRecord } from "./schemas";
import {
  createEmailIntakeRepository,
  recordsShareIdentity,
  type EmailIntakeRepositoryOptions,
} from "./repository";

export interface EmailIntakeJsonStore {
  read(): Promise<unknown>;
  write(records: readonly EmailIntakeRecord[]): Promise<void>;
  insertIfAbsent?(record: EmailIntakeRecord): Promise<boolean>;
  replaceOne?(record: EmailIntakeRecord): Promise<boolean>;
  removeOne?(record: EmailIntakeRecord): Promise<boolean>;
}

export function createJsonEmailIntakeRepository(
  store: EmailIntakeJsonStore,
  options: EmailIntakeRepositoryOptions = {},
) {
  let pending = Promise.resolve();
  const serialize = async <Value>(work: () => Promise<Value>) => {
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const read = async () => emailIntakeRecordListSchema.parse(await store.read());

  return createEmailIntakeRepository({
    list: read,
    insert: (record) => store.insertIfAbsent ? store.insertIfAbsent(record) : serialize(async () => {
      const records = await read();
      if (records.some((item) => recordsShareIdentity(item, record))) return false;
      await store.write([...records, record]);
      return true;
    }),
    replace: (record) => store.replaceOne ? store.replaceOne(record) : serialize(async () => {
      const records = await read();
      const index = records.findIndex((item) => item.intakeId === record.intakeId);
      if (index < 0) return false;
      const next = [...records];
      next[index] = record;
      await store.write(next);
      return true;
    }),
    remove: (record) => store.removeOne ? store.removeOne(record) : serialize(async () => {
      const records = await read();
      const next = records.filter((item) => item.intakeId !== record.intakeId);
      if (next.length === records.length) return false;
      await store.write(next);
      return true;
    }),
  }, options);
}
