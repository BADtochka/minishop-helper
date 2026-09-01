import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { JobQueue } from "../jobs/queue";
import { PreviewRepository } from "./previews";
import { handlePreviewCallback } from "./preview-handler";
import { previewText } from "./previews";

describe("preview callbacks", () => {
  test("reject purges only its draft, jobs, images, and request while retaining update idempotency", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const rejected = queue.enqueue({ updateId: 101, chatId: "42", requestData: { incomingMessageId: 8 }, jobData: { images: [{ dataBase64: "secret" }] } });
    const other = queue.enqueue({ updateId: 102, chatId: "42", requestData: {}, jobData: {} });
    if (rejected.duplicate || other.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: rejected.requestId, issue: { type: "bug", title: "Reject", description: "body", labels: [], confidence: 1 }, images: [{ mimeType: "image/png", dataBase64: "secret" }], chatId: "42" });
    previews.setMessage(rejected.requestId, 9);
    previews.setImageMessages(rejected.requestId, [10, 11]);
    const deleted: number[] = [];
    const answers: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, update: { update_id: 103 }, callbackQuery: { data: `reject:${rejected.requestId}`, message: { message_id: 9 } }, api: { deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId); } }, answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); } } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); } }) });
    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); } }) });

    expect(database.query("SELECT COUNT(*) AS count FROM issue_previews").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM requests WHERE id = ?").get(rejected.requestId)).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs WHERE request_id = ?").get(rejected.requestId)).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM requests WHERE id = ?").get(other.requestId)).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM processed_updates").get()).toEqual({ count: 2 });
    expect(deleted).toEqual([8, 9, 10, 11]);
    expect(answers).toEqual(["Отклонено и удалено", "Предпросмотр не найден."]);
  });

  test("keeps a purged rejection final when Telegram deletion fails", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queued = new JobQueue(database).enqueue({ updateId: 104, chatId: "42", requestData: {}, jobData: {} });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Reject", description: "body", labels: [], confidence: 1 }, chatId: "42" });
    previews.setMessage(queued.requestId, 9);
    const logs: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, update: { update_id: 105 }, callbackQuery: { data: `reject:${queued.requestId}`, message: { message_id: 9 } }, api: { deleteMessage: async () => { throw new Error("denied"); } }, answerCallbackQuery: async () => undefined } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); } }), logger: { info: () => undefined, error: (event) => { logs.push(event); } } });

    expect(previews.get(queued.requestId)).toBeUndefined();
    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 0 });
    expect(logs).toEqual(["telegram.preview_delete_failed"]);
  });

  test("creates once and preserves topic/reply metadata on duplicate confirmation", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const repository = { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "https://example.test/a/r", defaultBranch: "main" };
    const queued = queue.enqueue({ updateId: 1, chatId: "42", messageThreadId: 77, sourceMessageId: 5, requestData: {}, jobData: { repositoryId: "repo", repository, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "bug", title: "Broken thing", description: "body", labels: ["bug"], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 5, previewMessageId: 9 });
    previews.setMessage(queued.requestId, 9);
    let creates = 0; let createdAttachments: unknown; const edits: unknown[][] = []; const answers: string[] = []; const deleted: number[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `confirm:${queued.requestId}`, message: { message_id: 9, message_thread_id: 77 } }, api: { editMessageText: async (...args: unknown[]) => { edits.push(args); }, deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId); } }, answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); } } as unknown as Context;
    const storedImage = { mimeType: "image/png", filename: "source.png", dataBase64: "aW1hZ2U=" };
    database.query("UPDATE jobs SET job_data = ? WHERE request_id = ?").run(JSON.stringify({ repositoryId: "repo", repository, prompt: "input", images: [storedImage] }), queued.requestId);
    const options = { database, ownerTelegramId: 1, providerForRepository: async () => ({ findIssueByMarker: async () => undefined, createIssue: async (_repository: unknown, input: { attachments?: unknown }) => { creates++; createdAttachments = input.attachments; return { id: "i", number: 1, title: "Broken thing", webUrl: "https://example.test/issues/1?a=1&b=2" }; } }) };
    await handlePreviewCallback(context, options); await handlePreviewCallback(context, options);
    expect(creates).toBe(1); expect(answers.at(-1)).toBe("Уже обработано.");
    expect(edits[0]?.[3]).toMatchObject({ message_thread_id: 77, reply_parameters: { message_id: 5 } });
    expect(database.query("SELECT status, issue_id FROM requests").get()).toEqual({ status: "completed", issue_id: "i" });
    expect(createdAttachments).toEqual([storedImage]);
    expect(deleted).toEqual([5]);
  });

  test("allows cancelling a clarification and restores preview actions", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 2, chatId: "42", messageThreadId: 77, sourceMessageId: 5, requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "https://example.test/a/r", defaultBranch: "main" }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 5, previewMessageId: 9 });
    previews.setMessage(queued.requestId, 9);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    let edited: unknown[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `cancel_clarify:${queued.requestId}`, message: { message_id: 9, message_thread_id: 77 } }, api: { editMessageText: async (...args: unknown[]) => { edited = args; } }, answerCallbackQuery: async () => undefined } as unknown as Context;
    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) });
    expect(database.query("SELECT status FROM issue_previews").get()).toEqual({ status: "pending_confirmation" });
    expect((edited[3] as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }).reply_markup.inline_keyboard[0]?.[0]?.text).toBe("Подтвердить");
  });

  test("renders provider metadata, the complete description, and generation usage", () => {
    const preview = { requestId: "request", issue: { type: "bug" as const, title: "Checkout <fails>", description: "Use `cart`.\n\n## Additional information\nError", labels: ["bug"], confidence: 0.9 }, usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.00055 }, status: "pending_confirmation", chatId: "42" };
    const text = previewText(preview);
    expect(text).toContain("# Checkout \\<fails\\>");
    expect(text).toContain("**Тип:** bug");
    expect(text).toContain("## Additional information\nError");
    expect(text).not.toContain("Actual result");
    expect(text).not.toContain("Expected result");
    expect(text).toContain("<footer>Токены: 120 (вход: 100, выход: 20)");
    expect(text).toContain("~$0.0006");
  });

  test("marks fallback usage as an estimate rather than a charge", () => {
    const text = previewText({ requestId: "request", issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, usage: { totalTokens: 20, inputTokens: 15, outputTokens: 5, estimatedCostUsd: 0.0001, estimated: true }, status: "pending_confirmation", chatId: "42" });
    expect(text).not.toContain("Оценка, не фактическое списание");
  });

  test("replaces a deleted preview through an inline recovery action", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 3, chatId: "42", requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, images: [{ mimeType: "image/png", dataBase64: Buffer.from("image").toString("base64") }], chatId: "42", previewMessageId: 9 }); previews.setMessage(queued.requestId, 9); previews.setImageMessages(queued.requestId, [8]);
    const sent: Array<{ text: string; options: any }> = [];
    const rich: Array<Record<string, any>> = [];
    const api = { getChatMember: async () => ({ status: "administrator" }), raw: { editMessageText: async () => { throw new Error("Bad Request: message to edit not found"); }, sendRichMessage: async (payload: Record<string, any>) => { rich.push(payload); return { message_id: 11 }; } }, editMessageText: async () => undefined, sendMessage: async (_chatId: string, text: string, options: any) => { sent.push({ text, options }); return { message_id: 10 }; }, editMessageCaption: async () => undefined, deleteMessage: async () => true };
    const options = { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) };
    const stale = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `confirm:${queued.requestId}`, message: { message_id: 9 } }, api, answerCallbackQuery: async () => undefined } as unknown as Context;
    await expect(handlePreviewCallback(stale, options)).resolves.toBeUndefined();
    expect(sent[0]?.options.reply_markup.inline_keyboard[0][0].callback_data).toBe(`recreate_preview:${queued.requestId}`);
    const recreate = { ...stale, callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId) } } as unknown as Context;
    await handlePreviewCallback(recreate, options);
    expect(rich[0]?.rich_message.markdown).toContain("# Task");
    expect(rich[0]?.rich_message.markdown).toEndWith("![](tg://photo?id=preview_image_1)");
    expect(previews.get(queued.requestId)?.previewMessageId).toBe(11);
    expect(rich[0]?.reply_markup.inline_keyboard[0].map((button: { callback_data: string }) => button.callback_data)).toEqual([`confirm:${queued.requestId}`, `reject:${queued.requestId}`, `clarify:${queued.requestId}`]);
    expect(previews.get(queued.requestId)?.imageMessageIds).toBeUndefined();
  });

  test("does not interrupt an active regeneration through a recovery callback", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 5, chatId: "42", requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, chatId: "42", previewMessageId: 10 });
    previews.setMessage(queued.requestId, 10);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(queued.requestId, "clarification_requested", "regenerating");
    const answers: string[] = []; const edits: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId) }, api: { editMessageText: async (_chatId: string, _messageId: number, text: string) => { edits.push(text); } }, answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); } } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) });

    expect(previews.get(queued.requestId)?.status).toBe("regenerating");
    expect(answers).toEqual([""]);
    expect(edits[0]).toContain("Предпросмотр обновляется");
  });

  test("restores the saved Issue when regenerating has no active job after restart", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 6, chatId: "42", requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "bug", title: "Saved issue", description: "saved body", labels: ["bug"], confidence: 0.8 }, usage: { totalTokens: 12 }, images: [{ mimeType: "image/png", dataBase64: Buffer.from("image").toString("base64") }], chatId: "42", previewMessageId: 10 });
    previews.setMessage(queued.requestId, 10);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(queued.requestId, "clarification_requested", "regenerating");
    database.query("UPDATE jobs SET status = 'failed' WHERE request_id = ?").run(queued.requestId);
    const rich: Array<Record<string, any>> = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId) }, api: { raw: { sendRichMessage: async (payload: Record<string, any>) => { rich.push(payload); return { message_id: 11 }; } }, deleteMessage: async () => true }, answerCallbackQuery: async () => undefined } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) });

    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    expect(previews.get(queued.requestId)?.status).toBe("pending_confirmation");
    expect(previews.get(queued.requestId)?.previewMessageId).toBe(11);
    expect(rich[0]?.rich_message.markdown).toContain("# Saved issue");
    expect(rich[0]?.rich_message.markdown).toContain("saved body");
    expect(rich[0]?.rich_message.media).toHaveLength(1);
  });

  test("keeps a fresh running regeneration active", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 7, chatId: "42", requestData: {}, jobData: {} });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", previewMessageId: 10 });
    previews.setMessage(queued.requestId, 10);
    previews.transition(queued.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(queued.requestId, "clarification_requested", "regenerating");
    database.query("UPDATE jobs SET status = 'running', attempts = 1, locked_at = ? WHERE request_id = ?").run(new Date().toISOString(), queued.requestId);
    const edits: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId) }, api: { editMessageText: async (_chatId: string, _messageId: number, text: string) => { edits.push(text); } }, answerCallbackQuery: async () => undefined } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) });

    expect(previews.get(queued.requestId)?.status).toBe("regenerating");
    expect(edits[0]).toContain("Сообщение будет заменено после завершения");
  });

  test("restores callback actions with a safe message when the provider fails", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 4, chatId: "42", requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, chatId: "42", previewMessageId: 9 });
    previews.setMessage(queued.requestId, 9);
    const edits: Array<{ text: string; options: any }> = [];
    const deleted: number[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, update: { update_id: 4 }, callbackQuery: { data: `confirm:${queued.requestId}`, message: { message_id: 9 } }, api: { editMessageText: async (_chat: string, _message: number, text: string, options: any) => { edits.push({ text, options }); }, deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId); } }, answerCallbackQuery: async () => undefined } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => { throw new Error("provider access_token=must-not-leak"); } });

    expect(edits.at(-1)?.text).toContain("Git provider сейчас недоступен");
    expect(edits.at(-1)?.text).not.toContain("must-not-leak");
    expect(edits.at(-1)?.options.reply_markup.inline_keyboard[0][0].text).toBe("Повторить");
    expect(previews.get(queued.requestId)?.status).toBe("pending_confirmation");
    expect(deleted).toEqual([]);
  });

  test("keeps completed state when Telegram cannot delete the published Issue source", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 106, chatId: "42", sourceMessageId: 5, requestData: {}, jobData: { repositoryId: "repo", repository: { id: "1", owner: "a", name: "r", fullName: "a/r", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "input" } });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Task", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 5 });
    previews.setMessage(queued.requestId, 9);
    const logs: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, update: { update_id: 107 }, callbackQuery: { data: `confirm:${queued.requestId}`, message: { message_id: 9 } }, api: { editMessageText: async () => undefined, deleteMessage: async () => { throw new Error("not enough rights"); } }, answerCallbackQuery: async () => undefined } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ findIssueByMarker: async () => undefined, createIssue: async () => ({ id: "i", number: 1, title: "Task", webUrl: "https://example.test/issues/1" }) }), logger: { info: () => undefined, error: (event) => { logs.push(event); } } });

    expect(previews.get(queued.requestId)?.status).toBe("completed");
    expect(database.query("SELECT status, issue_id FROM requests").get()).toEqual({ status: "completed", issue_id: "i" });
    expect(logs).toEqual(["telegram.source_delete_failed"]);
  });

  test("accepts a valid stale recovery callback after another recovery notice replaced its stored id", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 8, chatId: "42", sourceMessageId: 5, requestData: {}, jobData: {} });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(queued.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: queued.requestId, issue: { type: "task", title: "Completed saved preview", description: "saved body", labels: [], confidence: 1 }, usage: { totalTokens: 42 }, chatId: "42", sourceMessageId: 5 });
    previews.setMessage(queued.requestId, 12);
    previews.transition(queued.requestId, "pending_confirmation", "completed");
    const rich: Array<Record<string, any>> = [];
    const answers: string[] = [];
    const context = { chat: { id: 42 }, from: { id: 1 }, callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId) }, api: { raw: { sendRichMessage: async (payload: Record<string, any>) => { rich.push(payload); return { message_id: 13 }; } }, deleteMessage: async () => true }, answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); } } as unknown as Context;

    await handlePreviewCallback(context, { database, ownerTelegramId: 1, providerForRepository: async () => ({ createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }) });

    expect(previews.get(queued.requestId)?.previewMessageId).toBe(13);
    expect(previews.get(queued.requestId)?.status).toBe("pending_confirmation");
    expect(rich[0]?.rich_message.markdown).toContain("# Completed saved preview");
    expect(rich[0]?.rich_message.markdown).toContain("Токены: 42");
    expect(answers).toEqual(["Предпросмотр создан."]);
  });

  test("does not resurrect a cancelled saved preview from an old recovery callback", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const queued = queue.enqueue({ updateId: 9, chatId: "42", messageThreadId: 77, sourceMessageId: 5, requestData: {}, jobData: {} });
    if (queued.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(queued.requestId);
    const previews = new PreviewRepository(database);
    previews.create({
      requestId: queued.requestId,
      issue: { type: "bug", title: "Cancelled saved preview", description: "saved body", labels: ["bug"], confidence: 0.9 },
      usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12, estimatedCostUsd: 0.001 },
      images: [{ mimeType: "image/png", dataBase64: Buffer.from("image").toString("base64") }],
      chatId: "42",
      messageThreadId: 77,
      sourceMessageId: 5,
    });
    previews.setMessage(queued.requestId, 10);
    previews.transition(queued.requestId, "pending_confirmation", "cancelled");
    const rich: Array<Record<string, any>> = [];
    const answers: string[] = [];
    let providerCalls = 0;
    const context = {
      chat: { id: 42 },
      from: { id: 1 },
      callbackQuery: { data: `recreate_preview:${queued.requestId}`, message: recoveryMessage(10, queued.requestId, 77) },
      api: { raw: { sendRichMessage: async (payload: Record<string, any>) => { rich.push(payload); return { message_id: 11 + rich.length }; } }, deleteMessage: async () => true },
      answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); },
    } as unknown as Context;
    const options = { database, ownerTelegramId: 1, providerForRepository: async () => { providerCalls++; return { createIssue: async () => { throw new Error("unused"); }, findIssueByMarker: async () => undefined }; } };

    await handlePreviewCallback(context, options);

    expect(previews.get(queued.requestId)?.status).toBe("cancelled");
    expect(previews.get(queued.requestId)?.previewMessageId).toBe(10);
    expect(rich).toHaveLength(0);
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    expect(providerCalls).toBe(0);
    expect(answers).toEqual(["Предпросмотр уже недоступен."]);
  });
});

function recoveryMessage(messageId: number, requestId: string, messageThreadId?: number): { message_id: number; message_thread_id?: number; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
  return { message_id: messageId, message_thread_id: messageThreadId, reply_markup: { inline_keyboard: [[{ text: "Восстановить предпросмотр", callback_data: `recreate_preview:${requestId}` }]] } };
}
