import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { consumePendingLink, consumeSetupAction, consumeSetupSession, createSetupSession } from "./setup-session";

describe("setup sessions", () => {
  const database = openDatabase(":memory:");
  afterEach(() => database.exec("DELETE FROM setup_sessions"));

  test("stores only a token hash and consumes a token once", async () => {
    migrate(database);
    const created = await createSetupSession(database, { chatId: "456", ownerTelegramId: 123 });
    expect(database.query<{ token_hash: string }, []>("SELECT token_hash FROM setup_sessions").get()?.token_hash).not.toBe(created.token);
    await expect(consumeSetupSession(database, created.token)).resolves.toMatchObject({ id: created.id, chatId: "456", ownerTelegramId: 123, flow: "legacy" });
    await expect(consumeSetupSession(database, created.token)).rejects.toThrow("already consumed");
  });
});

test("setup action validates context before consuming", async () => {
  const database = openDatabase(":memory:"); migrate(database);
  const created = await createSetupSession(database, { chatId: "42", ownerTelegramId: 7, flow: "repositories", originMessageId: 9 });
  await expect(consumeSetupAction(database, created.action, { chatId: "wrong", ownerTelegramId: 7, messageId: 9 })).rejects.toMatchObject({ code: "ACTION_WRONG_CONTEXT" });
  await expect(consumeSetupAction(database, created.action, { chatId: "42", ownerTelegramId: 7, messageId: 9 })).resolves.toMatchObject({ flow: "repositories" });
  await expect(consumeSetupAction(database, created.action, { chatId: "42", ownerTelegramId: 7, messageId: 9 })).rejects.toMatchObject({ code: "ACTION_REPLAYED" });
});

test("pending link selection is owner-scoped and consumed once", async () => {
  const database = openDatabase(":memory:"); migrate(database);
  await createSetupSession(database, { chatId: "1", ownerTelegramId: 1, flow: "link:repo" });
  expect(() => consumePendingLink(database, 2)).toThrow("LINK_MISSING");
  expect(consumePendingLink(database, 1)).toMatchObject({ flow: "link:repo" });
  expect(() => consumePendingLink(database, 1)).toThrow("LINK_MISSING");
});

test("pending link selection rejects ambiguous sessions", async () => {
  const database = openDatabase(":memory:"); migrate(database);
  await createSetupSession(database, { chatId: "1", ownerTelegramId: 1, flow: "link:repo-a" });
  await createSetupSession(database, { chatId: "1", ownerTelegramId: 1, flow: "link:repo-b" });
  expect(() => consumePendingLink(database, 1)).toThrow("LINK_AMBIGUOUS");
});
