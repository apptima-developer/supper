import { describe, expect, it } from "vitest";
import { IntegrationBoundaryError } from "../integrations";
import { DuplicateEmailIntake, EmailIntakeNotFound } from "./errors";
import { createJsonEmailIntakeRepository, type EmailIntakeJsonStore } from "./json-repository";
import { createRelationalEmailIntakeRepository, type EmailIntakeRelationalStore } from "./relational-repository";
import { createEmailIntakeRepositoryForBackend } from "./repository-factory";
import { recordsShareIdentity, type EmailIntakeRepository } from "./repository";
import type { EmailIntakeRecord } from "./schemas";
import { context, correlationId, createAggregate } from "./test-fixtures";

function jsonStore(): EmailIntakeJsonStore {
  let records: EmailIntakeRecord[] = [];
  return {
    read: async () => structuredClone(records),
    write: async (next) => { records = structuredClone([...next]); },
  };
}

function relationalStore(): EmailIntakeRelationalStore {
  const records = new Map<string, EmailIntakeRecord>();
  return {
    list: async () => structuredClone([...records.values()]),
    insert: async (record) => {
      if ([...records.values()].some((item) => recordsShareIdentity(item, record))) return false;
      records.set(record.intakeId, structuredClone(record));
      return true;
    },
    replace: async (record) => {
      if (!records.has(record.intakeId)) return false;
      records.set(record.intakeId, structuredClone(record));
      return true;
    },
    remove: async (record) => records.delete(record.intakeId),
  };
}

const repositoryFactories = [
  ["JSON", () => createJsonEmailIntakeRepository(jsonStore(), { allowTestDelete: true })],
  ["relational", () => createRelationalEmailIntakeRepository(relationalStore(), { allowTestDelete: true })],
] as const;

function contract(name: string, createRepository: () => EmailIntakeRepository) {
  describe(`${name} email intake repository contract`, () => {
    it("creates, finds, checks existence, updates, and prevents duplicates", async () => {
      const repository = createRepository();
      const aggregate = createAggregate("message-contract-1");
      await repository.create(aggregate);

      expect(await repository.exists({ intakeId: aggregate.intakeId })).toBe(true);
      expect(await repository.exists({ idempotencyKey: aggregate.idempotencyKey })).toBe(true);
      expect(await repository.exists({ provider: aggregate.provider, externalMessageId: aggregate.externalMessageId })).toBe(true);
      expect((await repository.findById(aggregate.intakeId))?.intakeId).toBe(aggregate.intakeId);
      expect((await repository.findByExternalMessageId("email", aggregate.externalMessageId))?.intakeId).toBe(aggregate.intakeId);
      await expect(repository.create(aggregate)).rejects.toBeInstanceOf(DuplicateEmailIntake);
      const sameExternalIdentity = (await import("./aggregate")).EmailIntakeAggregate.rehydrate({
        ...aggregate.toRecord(),
        intakeId: "intake-distinct-id",
      });
      await expect(repository.create(sameExternalIdentity)).rejects.toBeInstanceOf(DuplicateEmailIntake);

      const revised = aggregate.revise({ subject: "Repository update" }, context("2026-07-18T03:30:00.000Z")).aggregate;
      await repository.update(revised);
      expect((await repository.findById(aggregate.intakeId))?.toRecord().subject).toBe("Repository update");
    });

    it("changes status through the aggregate and persists audit and events", async () => {
      const repository = createRepository();
      const aggregate = createAggregate("message-contract-2");
      await repository.create(aggregate);
      const result = await repository.changeStatus(aggregate.intakeId, "VALIDATED", context("2026-07-18T03:31:00.000Z"));

      expect(result.events[0].eventType).toBe("EmailValidated");
      expect((await repository.findById(aggregate.intakeId))?.currentStatus).toBe("VALIDATED");
      expect(result.aggregate.auditHistory.at(-1)).toMatchObject({ action: "status_changed", nextStatus: "VALIDATED" });
      await expect(repository.changeStatus("missing", "VALIDATED", context("2026-07-18T03:32:00.000Z"))).rejects.toBeInstanceOf(EmailIntakeNotFound);
    });

    it("filters, sorts, and paginates deterministically", async () => {
      const repository = createRepository();
      const first = createAggregate("message-search-a");
      const secondRecord = createAggregate("message-search-b").toRecord();
      const thirdRecord = createAggregate("message-search-c").toRecord();
      const second = (await import("./aggregate")).EmailIntakeAggregate.rehydrate({
        ...secondRecord,
        subject: "Alpha outage",
        sender: { address: "alerts@example.com" },
        receivedAt: "2026-07-18T03:20:31.000Z",
      });
      const third = (await import("./aggregate")).EmailIntakeAggregate.rehydrate({
        ...thirdRecord,
        subject: "Beta outage",
        sender: { address: "alerts@example.com" },
        receivedAt: "2026-07-18T03:20:32.000Z",
      });
      await repository.create(first);
      await repository.create(second);
      await repository.create(third);

      const filtered = await repository.search({ sender: "alerts", subject: "outage", sortBy: "subject", sortDirection: "asc", page: 1, pageSize: 1 });
      expect(filtered).toMatchObject({ total: 2, page: 1, pageSize: 1, totalPages: 2 });
      expect(filtered.items[0].toRecord().subject).toBe("Alpha outage");
      const secondPage = await repository.search({ sender: "alerts", sortBy: "receivedAt", sortDirection: "asc", page: 2, pageSize: 1 });
      expect(secondPage.items[0].toRecord().subject).toBe("Beta outage");
      expect((await repository.search({ status: "RECEIVED" })).total).toBe(3);
      expect((await repository.search({ provider: "email", correlationId })).total).toBe(3);
      expect((await repository.search({ receivedFrom: "2026-07-18T03:20:31.000Z", receivedTo: "2026-07-18T03:20:32.000Z" })).total).toBe(2);
    });

    it("allows test deletion only when explicitly enabled", async () => {
      const repository = createRepository();
      const aggregate = createAggregate("message-delete");
      await repository.create(aggregate);
      expect(await repository.deleteForTestsOnly(aggregate.intakeId, correlationId)).toBe(true);
      expect(await repository.findById(aggregate.intakeId)).toBeUndefined();
    });
  });
}

for (const [name, createRepository] of repositoryFactories) contract(name, createRepository);

describe("email intake repository factory", () => {
  it("routes both JSON backend modes through the JSON repository", async () => {
    for (const backend of ["local-json", "supabase"] as const) {
      const repository = await createEmailIntakeRepositoryForBackend({ backend, jsonStore: jsonStore(), allowTestDelete: true });
      const aggregate = createAggregate(`message-factory-${backend}`);
      await repository.create(aggregate);
      expect((await repository.list()).map((item) => item.intakeId)).toEqual([aggregate.intakeId]);
    }
  });

  it("routes relational mode through the relational repository", async () => {
    const repository = await createEmailIntakeRepositoryForBackend({
      backend: "supabase-relational",
      relationalStore: relationalStore(),
      allowTestDelete: true,
    });
    const aggregate = createAggregate("message-factory-relational");
    await repository.create(aggregate);
    expect((await repository.findById(aggregate.intakeId))?.provider).toBe("email");
  });

  it("keeps test deletion disabled by default", async () => {
    const repository = createJsonEmailIntakeRepository(jsonStore());
    await expect(repository.deleteForTestsOnly("missing", correlationId)).rejects.toBeInstanceOf(IntegrationBoundaryError);
  });
});
