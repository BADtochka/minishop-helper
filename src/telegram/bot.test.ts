import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import { loadConfig } from "../config";
import type { Logger } from "../logger";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { JobQueue } from "../jobs/queue";
import { bootTelegram, CODEX_LOGIN_COMPLETED_MESSAGE, createCodexLoginCompletionNotifier } from "./bot";
import { isLinkCommand } from "./commands";
import { PreviewRepository } from "./previews";

function fakeBot(start: (options?: { onStart?: () => void }) => Promise<void> = async (options) => options?.onStart?.()) {
  const calls = { deleteWebhook: [] as unknown[], setWebhook: [] as unknown[], setMyCommands: [] as unknown[], sendMessage: [] as unknown[], editMessageText: [] as unknown[], stop: 0 };
  const commands = new Map<string, (context: any) => Promise<void>>();
  const callbacks: Array<(context: any) => Promise<void>> = [];
  const handlers = new Map<string, Array<(context: any, next: () => Promise<void>) => Promise<void>>>();
  const middleware: Array<(context: any, next: () => Promise<void>) => Promise<void>> = [];
  const bot = {
    api: {
      getMe: async () => ({ id: 99, is_bot: true, first_name: "Helper", username: "helper_bot" }),
      deleteWebhook: async (value: unknown) => { calls.deleteWebhook.push(value); return true; },
      setWebhook: async (...args: unknown[]) => { calls.setWebhook.push(args); return true; },
      setMyCommands: async (value: unknown) => { calls.setMyCommands.push(value); return true; },
      sendMessage: async (...args: unknown[]) => { calls.sendMessage.push(args); return { message_id: 1 }; },
      editMessageText: async (...args: unknown[]) => { calls.editMessageText.push(args); return true; },
    },
    command: (name: string, handler: (context: any) => Promise<void>) => { commands.set(name, handler); return bot; },
    on: (filter: string, handler: (context: any, next: () => Promise<void>) => Promise<void>) => { if (filter === "callback_query:data") callbacks.push(handler as any); else handlers.set(filter, [...(handlers.get(filter) ?? []), handler]); return bot; },
    use: (handler: (context: any, next: () => Promise<void>) => Promise<void>) => { middleware.push(handler); return bot; },
    catch: () => bot,
    start,
    stop: async () => { calls.stop += 1; },
    botInfo: undefined,
  };
  return { bot: bot as unknown as Bot, calls, commands, callbacks, handlers, middleware };
}

function fakeLogger() {
  const events: Array<{ level: "info" | "error"; event: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = { info: (event, fields) => events.push({ level: "info", event, fields }), error: (event, fields) => events.push({ level: "error", event, fields }) };
  return { logger, events };
}

function fixture() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES ('connection', 'gitlab', 1, 'secret')").run();
  database.query("INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name, default_branch, enabled) VALUES ('repo', 'connection', 'remote-1', 'acme/shop', 'main', 1)").run();
  return database;
}

function config() {
  return loadConfig({ OWNER_TELEGRAM_ID: "1", TELEGRAM_MODE: "polling", TELEGRAM_TOKEN: "token", PUBLIC_URL: "https://bot.example.com" });
}

function button(replies: Array<{ text: string; options?: any }>, text: string): string {
  for (const reply of [...replies].reverse()) {
    for (const row of reply.options?.reply_markup?.inline_keyboard ?? []) {
      const found = row.find((item: any) => item.text === text);
      if (found?.callback_data) return found.callback_data;
    }
  }
  throw new Error(`Button not found: ${text}`);
}

async function callback(fake: ReturnType<typeof fakeBot>, data: string, replies: Array<{ text: string; options?: any }>, from = 1) {
  const answers: string[] = [];
  await fake.callbacks[0]!({
    from: { id: from }, chat: { id: from, type: "private" }, callbackQuery: { data, message: { message_id: 10 } }, update: { update_id: 50 },
    api: { getChatMember: async () => ({ status: "administrator" }), editMessageText: async (_chatId: number, _messageId: number, text: string, options?: any) => { replies.push({ text, options }); } },
    answerCallbackQuery: async (value?: { text?: string }) => { answers.push(value?.text ?? ""); },
    reply: async (text: string, options?: any) => { replies.push({ text, options }); },
  });
  return answers;
}

async function startMenu(fake: ReturnType<typeof fakeBot>, replies: Array<{ text: string; options?: any }>) {
  await fake.commands.get("start")!({ from: { id: 1 }, chat: { id: 1, type: "private" }, update: { update_id: 42 }, reply: async (text: string, options?: any) => { replies.push({ text, options }); } });
}

describe("Telegram transport lifecycle", () => {
  test("dispatches a raw guest Rich Message reply to the clarification handler", async () => {
    const database = fixture();
    const queue = new JobQueue(database);
    const initial = queue.enqueue({ updateId: 1, chatId: "42", messageThreadId: 77, sourceMessageId: 7, requestData: {}, jobData: { repositoryId: "repo", repository: { id: "remote-1", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: false, webUrl: "", defaultBranch: "main" }, prompt: "original" } });
    if (initial.duplicate) throw new Error("unexpected duplicate");
    database.query("UPDATE jobs SET status = 'completed' WHERE request_id = ?").run(initial.requestId);
    const previews = new PreviewRepository(database);
    previews.create({ requestId: initial.requestId, issue: { type: "bug", title: "Broken checkout", description: "body", labels: [], confidence: 1 }, chatId: "42", messageThreadId: 77, sourceMessageId: 7, previewMessageId: 9 });
    previews.setMessage(initial.requestId, 9);
    previews.transition(initial.requestId, "pending_confirmation", "clarification_requested");
    const sent: Array<Record<string, unknown>> = [];
    const realBot = new Bot("token");
    realBot.api.config.use(async (_prev, method, payload) => {
      if (method === "getMe") return { ok: true, result: { id: 99, is_bot: true, first_name: "Helper", username: "MinishopHelperBot" } } as never;
      if (method === "getChatMember") return { ok: true, result: { status: "administrator", user: { id: 7, is_bot: false, first_name: "Admin" }, can_be_edited: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: true, can_restrict_members: true, can_promote_members: false, can_change_info: true, can_invite_users: true, can_post_stories: false, can_edit_stories: false, can_delete_stories: false, is_anonymous: false } } as never;
      if (method === "sendMessage") { sent.push(payload as Record<string, unknown>); return { ok: true, result: { message_id: 12, date: 0, chat: { id: 42, type: "supergroup" }, text: String((payload as { text?: unknown }).text ?? "") } } as never; }
      return { ok: true, result: true } as never;
    });
    const { logger } = fakeLogger();
    const telegram = await bootTelegram(config(), logger, { database, queue, integrationsAvailable: true }, { createBot: () => realBot });

    await telegram.bot!.handleUpdate({
      update_id: 227680728,
      guest_message: {
        message_id: 10,
        date: 0,
        chat: { id: 42, type: "supergroup" },
        from: { id: 7, is_bot: false, first_name: "Admin" },
        guest_query_id: "guest-query",
        message_thread_id: 88,
        text: "проблема относится к miniapp в боте @MinishopHelperBot",
        reply_to_message: { message_id: 9, date: 0, chat: { id: 42, type: "supergroup" }, rich_message: { blocks: [] }, reply_markup: { inline_keyboard: [[{ text: "Отменить уточнение", callback_data: `cancel_clarify:${initial.requestId}` }]] } },
      },
    } as never);

    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
    expect(previews.get(initial.requestId)?.status).toBe("regenerating");
    expect(sent).not.toContainEqual(expect.objectContaining({ text: "Уточнение принято. Предпросмотр будет обновлён." }));
  });

  test("sends Codex completion to the configured owner", async () => {
    const fake = fakeBot();
    await createCodexLoginCompletionNotifier(fake.bot, 42)();
    expect(fake.calls.sendMessage).toEqual([[42, CODEX_LOGIN_COMPLETED_MESSAGE]]);
  });

  test("activates polling once without dropping pending updates", async () => {
    const { logger } = fakeLogger();
    let release!: () => void;
    const polling = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeBot((options) => { options?.onStart?.(); return polling; });
    const telegram = await bootTelegram(config(), logger, undefined, { createBot: () => fake.bot });
    await telegram.activate();
    await telegram.activate();
    expect(fake.calls.deleteWebhook).toEqual([{ drop_pending_updates: false }]);
    expect(telegram.status).toBe("ready");
    release();
    await telegram.stop();
    expect(fake.calls.stop).toBe(1);
  });

  test("sets webhook only during activation", async () => {
    const fake = fakeBot();
    const { logger } = fakeLogger();
    const telegram = await bootTelegram(loadConfig({ OWNER_TELEGRAM_ID: "1", TELEGRAM_MODE: "webhook", TELEGRAM_TOKEN: "token", PUBLIC_URL: "http://localhost:3000", TELEGRAM_WEBHOOK_SECRET: "secret" }), logger, undefined, { createBot: () => fake.bot });
    expect(fake.calls.setWebhook).toHaveLength(0);
    await telegram.activate();
    expect(fake.calls.setWebhook).toHaveLength(1);
  });

  test("registers only /start and renders an opaque Russian menu", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    expect(fake.calls.setMyCommands).toEqual([[{ command: "start", description: "Открыть меню Minishop Helper" }]]);
    expect([...fake.commands.keys()]).toEqual(["start"]);
    expect(replies[0]!.text).toContain("Все действия выполняются кнопками");
    expect(button(replies, "Статус")).toMatch(/^s:[A-Za-z0-9_-]+$/);
  });

  test("creates provider OAuth link directly from a callback", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Подключить GitLab"), replies);
    const url = replies.at(-1)?.options.reply_markup.inline_keyboard[0][0].url;
    expect(url).toStartWith("https://bot.example.com/auth/gitlab/start?token=");
    expect(replies.at(-1)?.text).not.toContain("выполните /");
  });

  test("executes Codex connect and logout buttons directly", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    let logoutCalls = 0;
    const codex = {
      readStatus: async () => ({ state: "connected" as const, email: "owner@example.com" }),
      startBrowserLogin: async () => ({ authUrl: "https://codex.example/login", loginId: "login-1" }),
      startDeviceLogin: async () => ({ verificationUrl: "https://codex.example/device", userCode: "CODE" }),
      logout: async () => { logoutCalls += 1; },
    } as any;
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true, codex }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Codex"), replies);
    await callback(fake, button(replies, "Подключить Codex"), replies);
    expect(replies.some((reply) => reply.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://codex.example/login")).toBe(true);
    await callback(fake, button(replies, "Выйти из Codex"), replies);
    expect(logoutCalls).toBe(1);
  });

  test("binds repository to a non-forum group and rejects replay and another user", async () => {
    const fake = fakeBot();
    const database = fixture();
    database.query("INSERT INTO observed_chats (chat_id, title, type, owner_authorized, admin_verified_at) VALUES ('-100', 'Shop team', 'supergroup', 1, CURRENT_TIMESTAMP)").run();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Выбрать репозиторий"), replies);
    await callback(fake, button(replies, "gitlab: acme/shop"), replies);
    await callback(fake, button(replies, "main"), replies);
    const chatAction = button(replies, "Shop team");
    await callback(fake, chatAction, replies);
    expect(database.query<{ repository_id: string; actor_owner_telegram_id: number; branch: string }, []>("SELECT repository_id, actor_owner_telegram_id, branch FROM chat_bindings WHERE chat_id = '-100'").get()).toEqual({ repository_id: "repo", actor_owner_telegram_id: 1, branch: "main" });
    await callback(fake, chatAction, replies);
    expect(replies.at(-1)?.text).toContain("уже выполнено");
    await callback(fake, button(replies, "Статус"), replies, 2);
    expect(replies.at(-1)?.text).toBe("Недостаточно прав.");
  });

  test("binds a forum group immediately without topic buttons", async () => {
    const fake = fakeBot();
    const database = fixture();
    database.query("INSERT INTO observed_chats (chat_id, title, type, is_forum, owner_authorized, admin_verified_at) VALUES ('-200', 'Forum', 'supergroup', 1, 1, CURRENT_TIMESTAMP)").run();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Выбрать репозиторий"), replies);
    await callback(fake, button(replies, "gitlab: acme/shop"), replies);
    await callback(fake, button(replies, "main"), replies);
    await callback(fake, button(replies, "Forum"), replies);
    expect(replies.at(-1)?.text).toContain("привязан к группе");
    expect(replies.at(-1)?.text).not.toContain("тема");
    expect(database.query("SELECT repository_id FROM chat_bindings WHERE chat_id = '-200'").get()).toEqual({ repository_id: "repo" });
  });

  test("explains an empty chat registry safely", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Выбрать репозиторий"), replies);
    await callback(fake, button(replies, "gitlab: acme/shop"), replies);
    await callback(fake, button(replies, "main"), replies);
    expect(replies.some((reply) => reply.text.includes("Telegram Bot API не перечисляет все группы"))).toBe(true);

    database.query("INSERT INTO observed_chats (chat_id, title, type, is_forum, owner_authorized, admin_verified_at) VALUES ('-300', 'Empty forum', 'supergroup', 1, 1, CURRENT_TIMESTAMP)").run();
    await callback(fake, button(replies, "Обновить список групп"), replies);
    await callback(fake, button(replies, "Empty forum"), replies);
    expect(replies.at(-1)?.text).toContain("привязан к группе");
  });

  test("executes status callback immediately", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true, getIntegrationStatus: () => ({ git: "connected", provider: "connected", repository: "configured", worker: "running" }) }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Статус"), replies);
    expect(replies.at(-1)?.text).toContain("Git: подключён");
  });

  test("logs update failures safely and reports them in Telegram", async () => {
    const fake = fakeBot();
    const { logger, events } = fakeLogger();
    await bootTelegram(config(), logger, undefined, { createBot: () => fake.bot });
    const replies: string[] = [];
    await fake.middleware[0]!({ update: { update_id: 99 }, chat: { id: 42 }, reply: async (text: string) => { replies.push(text); } }, async () => { throw new Error("database connection failed"); });
    expect(events.at(-1)).toEqual({ level: "error", event: "telegram.update_failed", fields: { error_code: "REQUEST_PROCESSING_FAILED", phase: "update", update_id: 99, chat_id: 42, reason: "Error: database connection failed", retryable: true } });
    expect(JSON.stringify(events)).not.toContain("user body");
    expect(replies.at(-1)).toContain("Не удалось обработать запрос");
  });

  test("recognizes only a matching /link command entity, case-insensitively", () => {
    const message = (text: string) => ({ text, entities: [{ type: "bot_command", offset: 0, length: text.length }] });
    expect(isLinkCommand(message("/link@HELPER_BOT"), "helper_bot")).toBe(true);
    expect(isLinkCommand(message("/link@other_bot"), "helper_bot")).toBe(false);
    expect(isLinkCommand({ text: "/link@helper_bot" }, "helper_bot")).toBe(false);
  });

  test("links a pending repository only for an owner administrator and deletes the successful command", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger, events } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies);
    await callback(fake, button(replies, "Выбрать репозиторий"), replies);
    await callback(fake, button(replies, "gitlab: acme/shop"), replies);
    await callback(fake, button(replies, "main"), replies);
    let deleted = 0;
    const groupReplies: string[] = [];
    const context = {
      from: { id: 1 }, chat: { id: -400, type: "supergroup", title: "Linked", is_forum: true },
      message: { chat: { id: -400, type: "supergroup", title: "Linked", is_forum: true }, message_thread_id: 12, text: "/link@helper_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] },
      api: { getChatMember: async () => ({ status: "administrator" }) },
      deleteMessage: async () => { deleted += 1; }, reply: async (text: string) => { groupReplies.push(text); },
    };
    await fake.handlers.get("message:entities")![0]!(context as any, async () => undefined);
    expect(database.query<{ repository_id: string }, []>("SELECT repository_id FROM chat_bindings WHERE chat_id = '-400'").get()).toEqual({ repository_id: "repo" });
    expect(database.query("SELECT * FROM observed_chats WHERE chat_id = '-400'").get()).toBeTruthy();
    expect(deleted).toBe(1);
    expect(groupReplies).toHaveLength(0);
    expect(events.some((event) => event.event === "telegram.link_accepted")).toBe(true);
    await fake.handlers.get("message:entities")![0]!(context as any, async () => undefined);
    expect(deleted).toBe(1);
  });

  test("rejects private and non-admin link attempts without deletion", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const handler = fake.handlers.get("message:entities")![0]!;
    const privateReplies: string[] = [];
    await handler({ from: { id: 1 }, chat: { id: 1, type: "private" }, message: { chat: { id: 1, type: "private" }, text: "/link@helper_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] }, reply: async (text: string) => { privateReplies.push(text); } } as any, async () => undefined);
    let deleted = 0;
    const groupReplies: string[] = [];
    await handler({ from: { id: 1 }, chat: { id: -401, type: "group", title: "No admin" }, message: { chat: { id: -401, type: "group", title: "No admin" }, text: "/link@helper_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] }, api: { getChatMember: async () => ({ status: "member" }) }, deleteMessage: async () => { deleted += 1; }, reply: async (text: string) => { groupReplies.push(text); } } as any, async () => undefined);
    expect(privateReplies.at(-1)).toContain("только в группе");
    expect(groupReplies.at(-1)).toContain("права администратора");
    expect(deleted).toBe(0);
  });

  test("keeps a successful link when Telegram refuses to delete its command", async () => {
    const fake = fakeBot();
    const database = fixture();
    const { logger } = fakeLogger();
    await bootTelegram(config(), logger, { database, queue: new JobQueue(database), integrationsAvailable: true }, { createBot: () => fake.bot });
    const replies: Array<{ text: string; options?: any }> = [];
    await startMenu(fake, replies); await callback(fake, button(replies, "Выбрать репозиторий"), replies); await callback(fake, button(replies, "gitlab: acme/shop"), replies); await callback(fake, button(replies, "main"), replies);
    const groupReplies: string[] = [];
    await fake.handlers.get("message:entities")![0]!({ from: { id: 1 }, chat: { id: -402, type: "group", title: "Delete denied" }, message: { chat: { id: -402, type: "group", title: "Delete denied" }, text: "/link@helper_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] }, api: { getChatMember: async () => ({ status: "administrator" }) }, deleteMessage: async () => { throw new Error("denied"); }, reply: async (text: string) => { groupReplies.push(text); } } as any, async () => undefined);
    expect(database.query("SELECT * FROM chat_bindings WHERE chat_id = '-402'").get()).toBeTruthy();
    expect(groupReplies).toHaveLength(0);
  });
});
