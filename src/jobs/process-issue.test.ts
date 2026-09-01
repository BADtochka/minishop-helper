import { describe, expect, test } from "bun:test";
import { IssueWorker, workerErrorFields } from "./worker";
import { JobQueue } from "./queue";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import type { GitRepository } from "../git/types";
import { estimateUsage, processIssue } from "./process-issue";
import { generateNormalizedIssue } from "./process-issue";
import { CredentialError } from "../storage/git-credentials";
import { PreviewRepository } from "../telegram/previews";

const repository: GitRepository = {
  id: "repo-1", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "https://example.test/acme/shop", defaultBranch: null,
};

describe("IssueWorker", () => {
  test("intersects labels, applies the fallback type, and appends the request marker", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const queue = new JobQueue(database);
    const enqueued = queue.enqueue({ updateId: 1, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (enqueued.duplicate) throw new Error("unexpected duplicate");
    let generatedInput: { prompt: string; allowedLabels: string[] } | undefined;
    let createdInput: { title: string; description?: string; labels?: string[] } | undefined;
    const feedback = { previews: 0 };
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async (input) => {
        generatedInput = input;
        return { type: "bug", title: "Broken checkout", description: "It fails.", labels: ["bug", "unknown", "bug"], confidence: 0.5 };
      } },
      provider: {
        listLabels: async () => [
          { name: "bug", color: "red", description: null },
          { name: "task", color: "blue", description: null },
        ],
        createIssue: async (_repository, input) => {
          createdInput = input;
          return { id: "1", number: 1, title: input.title, webUrl: "https://example.test/issues/1" };
        },
      },
    }, { telegram: { sendMessage: async () => ({ message_id: 11 }), editMessageText: async () => undefined, sendPreview: async () => { feedback.previews++; return { message_id: 12 }; }, sendPreviewRecovery: async () => ({ message_id: 13 }), editPreview: async () => undefined, cleanupLegacyPreviewImages: async () => undefined } });
    await worker.runOnce();

    expect(generatedInput?.allowedLabels).toEqual(["bug", "task"]);
    expect(createdInput).toBeUndefined();
    expect(feedback.previews).toBe(1);
    expect(database.query("SELECT status FROM requests").get()).toEqual({ status: "pending_confirmation" });
  });

  test("fails the request and job when issue processing fails", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const queue = new JobQueue(database);
    queue.enqueue({ updateId: 2, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    const messages: string[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => { throw new Error("Codex unavailable"); } },
      provider: {
        listLabels: async () => [],
        createIssue: async () => { throw new Error("not reached"); },
      },
    }, { telegram: { ...previewTransport(), editMessageText: async (_chat, _message, text) => { messages.push(text); } } });

    await expect(worker.runOnce()).rejects.toThrow("Codex unavailable");

    expect(database.query("SELECT status FROM jobs").get()).toEqual({ status: "failed" });
    expect(database.query("SELECT status FROM requests").get()).toEqual({ status: "failed" });
    expect(messages.at(-1)).toContain("Codex не смог обработать запрос");
    expect(messages.join(" ")).not.toContain("Codex unavailable");
  });

  test("deletes the administrator ping only after a preview is successfully stored and rendered", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    queue.enqueue({ updateId: 21, chatId: "1", requestData: { incomingMessageId: 8 }, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    const deleted: number[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => ({ type: "task", title: "Preview", description: "body", labels: [], confidence: 1 }) },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
    }, { telegram: { ...previewTransport(), deleteMessage: async (_chatId, messageId) => { deleted.push(messageId); } } });

    await worker.runOnce();

    expect(deleted).toEqual([8]);
    expect(database.query("SELECT status FROM issue_previews").get()).toEqual({ status: "pending_confirmation" });
  });

  test("keeps the administrator ping when final preview rendering fails", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    queue.enqueue({ updateId: 22, chatId: "1", requestData: { incomingMessageId: 8 }, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    const deleted: number[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => ({ type: "task", title: "Preview", description: "body", labels: [], confidence: 1 }) },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
    }, { telegram: { ...previewTransport(), editPreview: async () => { throw new Error("Telegram unavailable"); }, deleteMessage: async (_chatId, messageId) => { deleted.push(messageId); } } });

    await expect(worker.runOnce()).rejects.toThrow("Telegram unavailable");

    expect(deleted).toEqual([]);
    expect(database.query("SELECT status FROM requests").get()).toEqual({ status: "failed" });
  });

  test("deletes a clarification only after regenerated preview editing succeeds", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 23, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Old", description: "old", labels: [], confidence: 1 }, chatId: "1" });
    previews.setMessage(queued.requestId, 9);
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(queued.requestId);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    queue.enqueueClarification(24, queued.requestId, { repositoryId: "local-repo-1", repository, prompt: "updated", clarificationMessageId: 10 });
    const deleted: number[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => ({ type: "task", title: "New", description: "new", labels: [], confidence: 1 }) },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
    }, { telegram: { ...previewTransport(), deleteMessage: async (_chatId, messageId) => { deleted.push(messageId); } } });

    await worker.runOnce();

    expect(deleted).toEqual([10]);
  });

  test("fails credential decryption without retrying and gives a safe reconnect instruction", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const queue = new JobQueue(database);
    queue.enqueue({ updateId: 20, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    const messages: string[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => ({}) },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("not reached"); } },
      providerForRepository: async () => { throw new CredentialError("CREDENTIAL_DECRYPTION_FAILED", "gitlab", 7, "credential_decryption"); },
    }, { telegram: { ...previewTransport(), sendMessage: async (_chatId, text) => { messages.push(text); return { message_id: 1 }; }, editMessageText: async (_chatId, _messageId, text) => { messages.push(text); } } });

    await expect(worker.runOnce()).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPTION_FAILED" });

    expect(database.query("SELECT status, attempts, error FROM jobs").get()).toEqual({ status: "failed", attempts: 1, error: "CREDENTIAL_DECRYPTION_FAILED" });
    expect(messages).toEqual([expect.stringContaining("APP_ENCRYPTION_KEY")]);
    expect(messages.join(" ")).not.toContain("access-token");
  });

  test("maps credential failures to structured logs without a secret", () => {
    const fields = workerErrorFields(new CredentialError("CREDENTIAL_DECRYPTION_FAILED", "gitlab", 7, "credential_decryption", { cause: new Error("token access-token") }));
    expect(fields).toMatchObject({ error_code: "CREDENTIAL_DECRYPTION_FAILED", provider: "gitlab", owner_telegram_id: 7, phase: "credential_decryption" });
    expect(JSON.stringify(fields)).not.toContain("access-token");
  });

  test("reconciles the request marker before repeating a provider side effect", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const queue = new JobQueue(database);
    const enqueued = queue.enqueue({ updateId: 3, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (enqueued.duplicate) throw new Error("unexpected duplicate");
    let creates = 0;
    const dependencies = {
      codex: { generateIssue: async () => ({ type: "task", title: "Recovered issue", description: "body", labels: [], confidence: 1 }) },
      provider: {
        listLabels: async () => [],
        findIssueByMarker: async (_repository: GitRepository, marker: string) => marker.includes(enqueued.requestId) ? { id: "existing", number: 9, title: "Recovered issue", webUrl: "https://example.test/issues/9" } : undefined,
        createIssue: async () => { creates++; throw new Error("must not create twice"); },
      },
    };
    await expect(processIssue(enqueued.requestId, { repositoryId: "local-repo-1", repository, prompt: "input" }, dependencies)).resolves.toMatchObject({ id: "existing" });
    expect(creates).toBe(0);
  });

  test("uses a refreshed persistent checkout only when repository mode supplies it", async () => {
    let input: { cwd?: string; repositoryContext?: string } | undefined;
    const issue = await generateNormalizedIssue({ repositoryId: "local-repo-1", repository, prompt: "input" }, {
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("not reached"); } },
      codex: { generateIssue: async (value) => { input = value; return { type: "task", title: "Title", description: "Body", labels: [], confidence: 1 }; } },
      repositoryCheckout: async () => ({ path: "/data/repositories/opaque", branch: "main", docs: [{ sourceId: "docs/overview.md", text: "VLESS subscriptions" }] }),
    });
    expect(issue.issue.title).toBe("Title");
    expect(input).toMatchObject({ cwd: "/data/repositories/opaque" });
    expect(input?.repositoryContext).toContain("branch main");
    expect(input?.repositoryContext).toContain("VLESS subscriptions");
  });

  test("offers a replacement when Telegram reports a deleted regenerated preview", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 30, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Old", description: "old", labels: [], confidence: 1 }, chatId: "1", previewMessageId: 9 });
    previews.setMessage(queued.requestId, 9);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    queue.enqueueClarification(31, queued.requestId, { repositoryId: "local-repo-1", repository, prompt: "updated" });
    let recoveryRequestId: string | undefined;
    const worker = new IssueWorker(queue, { codex: { generateIssue: async () => ({ type: "task", title: "New", description: "new", labels: [], confidence: 1 }) }, provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } } }, {
      telegram: { ...previewTransport(), editPreview: async () => { throw new Error("Bad Request: message to edit not found"); }, sendPreviewRecovery: async (_chatId, _text, requestId) => { recoveryRequestId = requestId; return { message_id: 10 }; } },
    });
    await worker.runOnce();
    expect(recoveryRequestId).toBe(queued.requestId);
    expect(previews.get(queued.requestId)).toMatchObject({ status: "pending_confirmation", previewMessageId: 10 });
  });

  test("finishes active regeneration into the latest stored recovery message", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 32, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Old", description: "old", labels: [], confidence: 1 }, chatId: "1" });
    previews.setMessage(queued.requestId, 9);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    queue.enqueueClarification(33, queued.requestId, { repositoryId: "local-repo-1", repository, prompt: "updated" });
    const editedMessageIds: number[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async () => { previews.replacePresentation(queued.requestId, 9, 12, []); return { type: "task", title: "New", description: "new", labels: [], confidence: 1 }; } },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
    }, { telegram: { ...previewTransport(), editPreview: async (_chatId, messageId) => { editedMessageIds.push(messageId); } } });

    await worker.runOnce();

    expect(editedMessageIds).toEqual([12]);
    expect(previews.get(queued.requestId)).toMatchObject({ status: "pending_confirmation", previewMessageId: 12 });
  });

  test("puts fresh usage in both initial and regenerated previews", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 40, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const rendered: string[] = [];
    let generation = 0;
    const worker = new IssueWorker(queue, {
      codex: {
        generateIssue: async () => { throw new Error("usage path expected"); },
        generateIssueWithUsage: async () => {
          generation++;
          return { issue: { type: "bug", title: `Title ${generation}`, description: "## Description\nFailure", labels: [], confidence: 1 }, usage: { totalTokens: generation * 100, inputTokens: generation * 80, outputTokens: generation * 20, estimatedCostUsd: generation * 0.001 } };
        },
      },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
    }, { telegram: { ...previewTransport(), editPreview: async (_chat, _message, text) => { rendered.push(text); } } });
    await worker.runOnce();
    const previews = new PreviewRepository(database);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    queue.enqueueClarification(41, queued.requestId, { repositoryId: "local-repo-1", repository, prompt: "updated" });
    await worker.runOnce();
    expect(rendered[0]).toContain("<footer>Токены: 100 (вход: 80, выход: 20)");
    expect(rendered[1]).toContain("<footer>Токены: 200 (вход: 160, выход: 40)");
    expect(previews.get(queued.requestId)?.usage).toMatchObject({ totalTokens: 200, inputTokens: 160, outputTokens: 40 });
  });

  test("refreshes repository docs again when a clarification regenerates a preview", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 50, chatId: "1", requestData: {}, jobData: { repositoryId: "local-repo-1", repository, prompt: "initial" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    let refreshes = 0;
    const contexts: string[] = [];
    const worker = new IssueWorker(queue, {
      codex: { generateIssue: async (input) => { contexts.push(input.repositoryContext ?? ""); return { type: "task", title: "Title", description: input.prompt, labels: [], confidence: 1 }; } },
      provider: { listLabels: async () => [], createIssue: async () => { throw new Error("unused"); } },
      repositoryCheckout: async () => ({ path: "/data/repositories/opaque", branch: "selected", docs: [{ sourceId: "docs/current.md", text: `revision ${++refreshes}` }] }),
    }, { telegram: previewTransport() });
    await worker.runOnce();
    new PreviewRepository(database).transition(queued.requestId, "pending_confirmation", "clarification_requested");
    queue.enqueueClarification(51, queued.requestId, { repositoryId: "local-repo-1", repository, prompt: "initial\n\nAdministrator clarification:\nmore detail" });
    await worker.runOnce();
    expect(refreshes).toBe(2);
    expect(contexts).toEqual([expect.stringContaining("revision 1"), expect.stringContaining("revision 2")]);
  });

  test("estimates missing subscription usage from text, context, images, and output", async () => {
    const issue = { type: "task" as const, title: "Title", description: "Body", labels: [], confidence: 1 };
    const first = estimateUsage("abcd", "efgh", [{ mimeType: "image/png", dataBase64: "AQ==" }], issue);
    const second = estimateUsage("abcd", "efgh", [{ mimeType: "image/png", dataBase64: "AQ==" }], issue);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ inputTokens: 767, totalTokens: expect.any(Number), estimated: true });
    expect(first.estimatedCostUsd).toBeGreaterThan(0);
  });
});

function previewTransport() {
  return { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => undefined, sendPreview: async () => ({ message_id: 2 }), sendPreviewRecovery: async () => ({ message_id: 3 }), editPreview: async () => undefined, cleanupLegacyPreviewImages: async () => undefined };
}
