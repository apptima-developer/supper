import { getDataBackend, type DataBackend } from "../env";
import { createJsonEmailIntakeRepository, type EmailIntakeJsonStore } from "./json-repository";
import { createRelationalEmailIntakeRepository, type EmailIntakeRelationalStore } from "./relational-repository";
import type { EmailIntakeRepository, EmailIntakeRepositoryOptions } from "./repository";

export type EmailIntakeRepositoryFactoryOptions = EmailIntakeRepositoryOptions & Readonly<{
  backend?: DataBackend;
  jsonStore?: EmailIntakeJsonStore;
  relationalStore?: EmailIntakeRelationalStore;
}>;

export async function createEmailIntakeRepositoryForBackend(
  options: EmailIntakeRepositoryFactoryOptions = {},
): Promise<EmailIntakeRepository> {
  const backend = options.backend ?? getDataBackend();
  const repositoryOptions = { allowTestDelete: options.allowTestDelete };
  if (backend === "supabase-relational") {
    const store = options.relationalStore
      ?? (await import("./supabase-relational-store")).createSupabaseRelationalEmailIntakeStore();
    return createRelationalEmailIntakeRepository(store, repositoryOptions);
  }
  const store = options.jsonStore ?? (backend === "supabase"
    ? (await import("./supabase-json-store")).createSupabaseEmailIntakeJsonStore()
    : (await import("./local-json-store")).createLocalEmailIntakeJsonStore());
  return createJsonEmailIntakeRepository(store, repositoryOptions);
}

let repositoryPromise: Promise<EmailIntakeRepository> | undefined;

export function getEmailIntakeRepository() {
  repositoryPromise ??= createEmailIntakeRepositoryForBackend();
  return repositoryPromise;
}
