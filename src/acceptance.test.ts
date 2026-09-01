import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import type { GitRepository } from "./git/types";
import { IssueWorker } from "./jobs/worker";
import { JobQueue } from "./jobs/queue";
import { migrate } from "./storage/migrations";
import { openDatabase } from "./storage/db";
import { handleTelegramRequest } from "./telegram/request-handler";
import { defaultProjectContext } from "./context/defaults";
import { selectComponents } from "./context/component-scorer";

const repository: GitRepository = {
  id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null,
  private: true, webUrl: "https://example.test/acme/shop", defaultBranch: "main",
};

describe("issue delivery acceptance", () => {
  test("maps Telegram Desktop status flags to miniapp/status, not an external Telegram failure", () => {
    const context = defaultProjectContext("3252a8/remnawave-minishop", "1")!;
    expect(selectComponents(context, "Telegram Desktop PC status flags")[0]?.id).toBe("miniapp/status");
    expect(context.disambiguationRules.join(" ")).toContain("not an external failing platform");
  });
  test("delivers one fake Telegram update through the queue to each provider and rejects invalid Codex output", async () => {
    for (const providerName of ["github", "gitlab"]) {
      const database = openDatabase(":memory:");
      migrate(database);
      database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', ?, 'encrypted')").run(providerName);
      database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('repository', 'connection', '99', 'acme/shop')").run();
      database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'repository')").run();
      const queue = new JobQueue(database);
      const context = telegramContext(100 + providerName.length);
      const options = { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true };

      await handleTelegramRequest(context, options);
      await handleTelegramRequest(context, options);

      let created = 0;
      const worker = new IssueWorker(queue, {
        codex: { generateIssue: async () => ({ type: "bug", title: "Checkout fails", description: "Failure", labels: ["bug"], confidence: 0.9 }) },
        provider: {
          listLabels: async () => [{ name: "bug", color: "red", description: null }],
          createIssue: async (_repository, input) => {
            created++;
            return { id: `${providerName}-1`, number: 1, title: input.title, webUrl: `https://example.test/${providerName}/1` };
          },
        },
      }, { telegram: previewTransport() });
      await worker.runOnce();

      expect(created).toBe(0);
      expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
      expect(database.query("SELECT status FROM requests").get()).toEqual({ status: "pending_confirmation" });
    }

    const database = openDatabase(":memory:");
    migrate(database);
    const queue = new JobQueue(database);
    queue.enqueue({ updateId: 999, chatId: "42", requestData: {}, jobData: { repositoryId: "repository", repository, prompt: "input" } });
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => ({ title: "missing required fields" }) },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("must not create issue"); } },
    }, { telegram: previewTransport() });
    await expect(worker.runOnce()).rejects.toThrow();
    expect(database.query("SELECT status FROM jobs").get()).toEqual({ status: "failed" });
  });
});

function telegramContext(updateId: number): Context {
  return {
    chat: { id: 42 }, from: { id: 7 },
    message: { message_id: 8, text: "Create issue @helper_bot", entities: [{ type: "mention", offset: 13, length: 11 }], reply_to_message: { message_id: 7, date: 0, chat: { id: 42, type: "group" }, text: "Checkout fails" } },
    update: { update_id: updateId }, api: { getChatMember: async () => ({ status: "administrator" }) },
  } as unknown as Context;
}

function previewTransport() {
  return { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => undefined, sendPreview: async () => ({ message_id: 2 }), sendPreviewRecovery: async () => ({ message_id: 3 }), editPreview: async () => undefined, cleanupLegacyPreviewImages: async () => undefined };
}
