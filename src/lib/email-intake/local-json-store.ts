import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { emailIntakeRecordListSchema, type EmailIntakeRecord } from "./schemas";
import type { EmailIntakeJsonStore } from "./json-repository";

export const emailIntakeJsonPath = "integrations/email-intakes.json";

export function createLocalEmailIntakeJsonStore(dataRoot = path.join(process.cwd(), "data")): EmailIntakeJsonStore {
  const target = path.resolve(dataRoot, emailIntakeJsonPath);
  const expectedRoot = path.resolve(dataRoot) + path.sep;
  if (!target.startsWith(expectedRoot)) throw new Error("Invalid email intake data path");

  return Object.freeze({
    async read() {
      try {
        return JSON.parse(await fs.readFile(target, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async write(records: readonly EmailIntakeRecord[]) {
      const parsed = emailIntakeRecordListSchema.parse(records);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  });
}
