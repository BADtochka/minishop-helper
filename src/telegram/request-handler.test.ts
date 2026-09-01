import { describe, expect, test } from "bun:test";
import { Context } from "grammy";
import { JobQueue } from "../jobs/queue";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { handleTelegramRequest } from "./request-handler";
import { PreviewRepository } from "./previews";

describe("Telegram request handler", () => {
  test("queues one valid update and ignores its duplicate delivery", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);
    const options = { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true };
    const update = contextFor({ updateId: 100, text: "Please create @helper_bot", source: "Checkout fails" });

    await handleTelegramRequest(update, options);
    await handleTelegramRequest(update, options);

    expect(database.query("SELECT COUNT(*) AS count FROM processed_updates").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
    expect(database.query<{ request_data: string }, []>("SELECT request_data FROM requests").get()?.request_data).toContain("Checkout fails");
    expect(JSON.parse(database.query<{ request_data: string }, []>("SELECT request_data FROM requests").get()!.request_data).incomingMessageId).toBe(8);
    expect(database.query<{ job_data: string }, []>("SELECT job_data FROM jobs").get()?.job_data).toContain("local-repo");
    expect(database.query("SELECT message_thread_id FROM requests").get()).toEqual({ message_thread_id: null });
  });

  test("keeps the source topic as delivery context while resolving the group binding", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);

    await handleTelegramRequest(contextFor({ updateId: 101, text: "Please create @helper_bot", source: "Checkout fails", threadId: 77 }), { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT message_thread_id FROM requests").get()).toEqual({ message_thread_id: 77 });
    expect(database.query<{ job_data: string }, []>("SELECT job_data FROM jobs").get()?.job_data).toContain("local-repo");
  });

  test("links an admin clarification to the existing topic preview", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", messageThreadId: 77, sourceMessageId: 7, requestData: { telegramUserId: 7 }, jobData: { repositoryId: "local-repo", repository: { id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "original", images: [{ mimeType: "image/png", dataBase64: "source-image" }] } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9); previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    const context = contextFor({ updateId: 2, text: "Details @helper_bot", source: "original", threadId: 77 });
    context.message!.photo = [{ file_id: "clarification-image", file_unique_id: "clarification-image", width: 1, height: 1 }];
    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true, downloadTelegramImage: async (fileId) => ({ mimeType: "image/png", dataBase64: fileId }) });
    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
    expect(previews.get(initial.requestId)?.status).toBe("regenerating");
    expect(JSON.parse(database.query<{ job_data: string }, []>("SELECT job_data FROM jobs ORDER BY rowid DESC LIMIT 1").get()!.job_data).images).toEqual([
      { mimeType: "image/png", dataBase64: "source-image" },
      { mimeType: "image/png", dataBase64: "clarification-image" },
    ]);
  });

  test("accepts clarification reply to a Rich Message without text or a second mention", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", messageThreadId: 77, sourceMessageId: 7, requestData: {}, jobData: { repositoryId: "local-repo", repository: { id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "original" } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9); previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    const context = contextFor({ updateId: 2, text: "Details without mention", source: "preview", threadId: 77 });
    context.message!.reply_to_message!.message_id = 9;
    delete context.message!.reply_to_message!.text;
    (context.message!.reply_to_message as unknown as { rich_message: object }).rich_message = { blocks: [] };
    context.message!.entities = [];
    const replies: string[] = [];
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];
    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
    expect(replies).toEqual([]);
  });

  test("accepts a same-chat external reply to an active preview", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", messageThreadId: 77, sourceMessageId: 7, requestData: {}, jobData: { repositoryId: "local-repo", repository: { id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "original" } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9); previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    const replies: string[] = [];
    const context = new Context({ update_id: 2, message: {
      message_id: 8, date: 0, message_thread_id: 88, chat: { id: 42, type: "supergroup" }, from: { id: 7, is_bot: false, first_name: "Admin" }, text: "Details from another topic", entities: [],
      external_reply: { chat: { id: 42, type: "supergroup" }, message_id: 9, origin: { type: "user", date: 0, sender_user: { id: 1, is_bot: false, first_name: "Source" } }, rich_message: { markdown: "# Preview" } },
    } } as never, { getChatMember: async () => ({ status: "administrator" }), sendMessage: async (_chatId: number | string, text: string) => { replies.push(text); return { message_id: 12 }; } } as never, { id: 99, is_bot: true, first_name: "Helper", username: "helper_bot" } as never);

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
    expect(replies).toEqual([]);
  });

  test("offers recovery for an admin clarification reply to the source while regenerating", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: { repositoryId: "local-repo", repository: { id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "original" } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9);
    previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(initial.requestId, "clarification_requested", "regenerating");
    const context = contextFor({ updateId: 2, text: "Clarification", source: "preview" });
    context.message!.entities = [];
    const replies: string[] = [];
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true, logger: { info: (event, fields) => events.push({ event, fields }), error: () => undefined } });

    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    expect(replies.at(-1)).toContain("Предпросмотр обновляется. Это сообщение будет заменено после завершения.");
    expect(replies.at(-1)).toContain("Уточнение не принято");
    expect(previews.get(initial.requestId)?.status).toBe("regenerating");
    expect(previews.get(initial.requestId)?.previewMessageId).toBe(12);
    expect(events).toContainEqual({ event: "telegram.clarification_filtered", fields: { update_id: 2, update_type: "message", chat_id: 42, reply_ids: [7], reference_kinds: ["reply_to_message"], status: "regenerating", reason: "not_awaiting_clarification" } });
  });

  test("offers restoration for a reply when regenerating has no active job", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 20, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: {} });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7, previewMessageId: 9 });
    previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(initial.requestId, "clarification_requested", "regenerating");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const context = contextFor({ updateId: 21, text: "Important clarification", source: "source" });
    context.message!.entities = [];
    const replies: Array<{ text: string; options: any }> = [];
    context.reply = (async (text: string, options: any) => { replies.push({ text, options }); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(replies[0]?.text).toContain("обновление прервалось");
    expect(replies[0]?.text).toContain("Уточнение не принято");
    expect(replies[0]?.options.reply_markup.inline_keyboard[0][0].callback_data).toBe(`recreate_preview:${initial.requestId}`);
    expect(previews.get(initial.requestId)?.previewMessageId).toBe(12);
  });

  test("replaces a deleted recovery notice on every bare retry without claiming a clarification", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 30, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: {} });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7 });
    previews.setMessage(initial.requestId, 9);
    const replies: Array<{ text: string; options: any; messageId: number }> = [];

    for (const [updateId, messageId] of [[31, 10], [32, 11]] as const) {
      const context = contextFor({ updateId, text: "@helper_bot", source: "source" });
      context.reply = (async (text: string, options: any) => { replies.push({ text, options, messageId }); return { message_id: messageId }; }) as Context["reply"];
      context.api.deleteMessage = async () => true;
      await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });
    }

    expect(replies).toHaveLength(2);
    expect(replies.every(({ text }) => !text.includes("Уточнение не принято"))).toBe(true);
    expect(replies.every(({ options }) => options.reply_markup.inline_keyboard[0][0].callback_data === `recreate_preview:${initial.requestId}`)).toBe(true);
    expect(previews.get(initial.requestId)?.previewMessageId).toBe(11);
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  });

  test("offers recovery for a cancelled preview without treating punctuation as clarification", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 33, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: {} });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7 });
    previews.setMessage(initial.requestId, 9);
    previews.transition(initial.requestId, "pending_confirmation", "cancelled");
    const context = contextFor({ updateId: 34, text: "@helper_bot...", source: "source" });
    const replies: Array<{ text: string; options: any }> = [];
    context.reply = (async (text: string, options: any) => { replies.push({ text, options }); return { message_id: 10 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(replies[0]?.text).toContain("Восстановить последний сохранённый предпросмотр?");
    expect(replies[0]?.text).not.toContain("Уточнение не принято");
    expect(replies[0]?.options.reply_markup.inline_keyboard[0][0].callback_data).toBe(`recreate_preview:${initial.requestId}`);
    expect(previews.get(initial.requestId)?.status).toBe("cancelled");
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  });

  test("treats a mentioned message replying to a purged Rich Message as a new request", async () => {
    const database = configuredDatabase();
    const queue = new JobQueue(database);
    const context = contextFor({ updateId: 35, text: "Новая задача @helper_bot", source: "" });
    context.message!.reply_to_message!.message_id = 133;
    delete context.message!.reply_to_message!.text;
    (context.message!.reply_to_message as unknown as { rich_message: object }).rich_message = { blocks: [] };

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
    expect(database.query("SELECT source_message_id FROM requests").get()).toEqual({ source_message_id: null });
    expect(database.query<{ job_data: string }, []>("SELECT job_data FROM jobs").get()?.job_data).toContain("Source message:\\nНовая задача");
  });

  test("treats a mentioned message replying to a cancelled Rich preview as a new request", async () => {
    const database = configuredDatabase();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 36, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: {} });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7, previewMessageId: 133 });
    previews.setMessage(initial.requestId, 133);
    previews.transition(initial.requestId, "pending_confirmation", "cancelled");
    const context = contextFor({ updateId: 37, text: "Исправить оплату @helper_bot", source: "" });
    context.message!.reply_to_message!.message_id = 133;
    delete context.message!.reply_to_message!.text;
    (context.message!.reply_to_message as unknown as { rich_message: object }).rich_message = { blocks: [] };

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 2 });
    expect(database.query<{ job_data: string }, []>("SELECT job_data FROM jobs ORDER BY rowid DESC LIMIT 1").get()?.job_data).toContain("Исправить оплату");
  });

  test("does not turn a mentioned reply to an active preview into a new request", async () => {
    const database = configuredDatabase();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 38, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: {} });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Saved", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7, previewMessageId: 133 });
    previews.setMessage(initial.requestId, 133);
    previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(initial.requestId, "clarification_requested", "regenerating");
    const context = contextFor({ updateId: 39, text: "Новая задача @helper_bot", source: "" });
    context.message!.reply_to_message!.message_id = 133;
    delete context.message!.reply_to_message!.text;
    (context.message!.reply_to_message as unknown as { rich_message: object }).rich_message = { blocks: [] };
    const replies: string[] = [];
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
    expect(replies.at(-1)).toContain("Предпросмотр обновляется");
  });

  test("gives recovery instructions for an empty reply to an unknown Rich Message", async () => {
    const database = configuredDatabase();
    const context = contextFor({ updateId: 40, text: "@helper_bot", source: "" });
    context.message!.reply_to_message!.message_id = 133;
    delete context.message!.reply_to_message!.text;
    (context.message!.reply_to_message as unknown as { rich_message: object }).rich_message = { blocks: [] };
    const replies: string[] = [];
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue: new JobQueue(database), botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 0 });
    expect(replies.at(-1)).toContain("Этот предпросмотр больше недоступен");
  });

  test("offers recovery for a same-chat external Rich Message reply while regenerating", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", sourceMessageId: 7, requestData: {}, jobData: { repositoryId: "local-repo", repository: { id: "99", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: null }, prompt: "original" } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9);
    previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    previews.transition(initial.requestId, "clarification_requested", "regenerating");
    const replies: Array<{ text: string; options: any }> = [];
    const context = new Context({ update_id: 2, message: {
      message_id: 8, date: 0, chat: { id: 42, type: "supergroup" }, from: { id: 7, is_bot: false, first_name: "Admin" }, text: "More details", entities: [],
      external_reply: { chat: { id: 42, type: "supergroup" }, message_id: 9, origin: { type: "user", date: 0, sender_user: { id: 1, is_bot: false, first_name: "Source" } }, rich_message: { markdown: "# Preview" } },
    } } as never, { getChatMember: async () => ({ status: "administrator" }), sendMessage: async (_chatId: number | string, text: string, options: any) => { replies.push({ text, options }); return { message_id: 12 }; } } as never, { id: 99, is_bot: true, first_name: "Helper", username: "helper_bot" } as never);

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    expect(replies[0]?.text).toContain("Уточнение не принято");
    expect(replies[0]?.text).toContain("Предпросмотр обновляется");
    expect(replies[0]?.options.reply_markup).toBeUndefined();
    expect(previews.get(initial.requestId)?.previewMessageId).toBe(12);
  });

  test("keeps images from the source and clarification for Codex", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);
    const source = contextFor({ updateId: 3, text: "Create @helper_bot", source: "" });
    source.message!.reply_to_message!.photo = [{ file_id: "source-image", file_unique_id: "source-image", width: 1, height: 1 }];
    await handleTelegramRequest(source, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true, downloadTelegramImage: async (fileId) => ({ mimeType: "image/png", dataBase64: fileId }) });
    const initial = queue.claimNext<unknown, { images?: Array<{ mimeType: string; dataBase64: string }> }>();
    expect(initial?.job.data.images).toEqual([{ mimeType: "image/png", dataBase64: "source-image" }]);
  });

  test("reports an incoming enqueue failure in Telegram without exposing its details", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const queue = new JobQueue(database);
    queue.enqueue = (() => { throw new Error("database token=must-not-leak"); }) as typeof queue.enqueue;
    const replies: string[] = [];
    const context = contextFor({ updateId: 110, text: "Create @helper_bot", source: "Checkout fails" });
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue, botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true });

    expect(replies.at(-1)).toContain("поставить запрос в очередь");
    expect(replies.join(" ")).not.toContain("must-not-leak");
  });

  test("reports attachment download failures with a retry action", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
    database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
    database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
    const context = contextFor({ updateId: 111, text: "Create @helper_bot", source: "" });
    context.message!.reply_to_message!.photo = [{ file_id: "image", file_unique_id: "image", width: 1, height: 1 }];
    const replies: string[] = [];
    context.reply = (async (text: string) => { replies.push(text); return { message_id: 12 }; }) as Context["reply"];

    await handleTelegramRequest(context, { database, queue: new JobQueue(database), botUsername: "helper_bot", ownerTelegramId: 1, integrationsAvailable: true, downloadTelegramImage: async () => { throw new Error("Telegram image download failed: https://api.telegram.org/file/bottop-secret/path"); } });

    expect(replies.at(-1)).toContain("Отправьте его ещё раз");
    expect(replies.join(" ")).not.toContain("top-secret");
  });
});

function contextFor(input: { updateId: number; text: string; source: string; threadId?: number }): Context {
  return {
    chat: { id: 42 },
    from: { id: 7 },
    message: {
      message_id: 8,
      message_thread_id: input.threadId,
      text: input.text,
      entities: [{ type: "mention", offset: input.text.indexOf("@helper_bot"), length: 11 }],
      reply_to_message: { message_id: 7, date: 0, chat: { id: 42, type: "group" }, text: input.source },
    },
    update: { update_id: input.updateId },
    api: { getChatMember: async () => ({ status: "administrator" }) },
  } as unknown as Context;
}

function configuredDatabase() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.query("INSERT INTO git_connections (id, provider, credentials_encrypted) VALUES ('connection', 'gitlab', 'encrypted')").run();
  database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('local-repo', 'connection', '99', 'acme/shop')").run();
  database.query("INSERT INTO chat_bindings (chat_id, repository_id) VALUES ('42', 'local-repo')").run();
  return database;
}
