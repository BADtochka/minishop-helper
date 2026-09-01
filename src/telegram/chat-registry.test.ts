import { describe, expect, test } from "bun:test";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { ChatRegistry } from "./chat-registry";

describe("ChatRegistry", () => {
  test("stores metadata only after bot and owner admin verification", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const registry = new ChatRegistry(database);
    const context = (statuses: string[]) => ({
      message: { chat: { id: -100, type: "supergroup", title: "Team", is_forum: true }, message_thread_id: 8, forum_topic_created: { name: "API" }, text: "must not be stored" },
      api: { getChatMember: async () => ({ status: statuses.shift() }) },
    }) as any;
    await registry.observe(context(["member", "administrator"]), 1, 99);
    expect(registry.listChats()).toHaveLength(0);
    await registry.observe(context(["administrator", "creator"]), 1, 99);
    expect(registry.listChats()).toEqual([{ chatId: "-100", title: "Team", type: "supergroup", isForum: true }]);
    expect(JSON.stringify(database.query("SELECT * FROM observed_chats").all())).not.toContain("must not be stored");
  });
});
