import type { Bot, Context, NextFunction } from "grammy";
import { CodexAuthError, maskAccount, type CodexAccountStatus, type CodexAuthService } from "../codex/auth";
import type { AppDatabase } from "../storage/db";
import { RepositoryBindingRepository } from "../storage/repository-bindings";
import type { RepositorySetupService } from "../git/setup-service";
import { consumePendingLink, consumeSetupAction, createSetupSession, PendingLinkError, SetupActionError, type ConsumedSetupSession } from "../auth/setup-session";
import type { Logger } from "../logger";
import { isAdministratorStatus, isOwner } from "./guards";
import { ChatRegistry } from "./chat-registry";
import { throttledProgress, type ProgressReporter } from "../progress";
import { isExpectedTelegramError, safeErrorFields } from "./errors";

type CommandOptions = {
  ownerTelegramId: number;
  botTelegramId: number;
  getStatus: () => "starting" | "ready" | "failed" | "not_configured";
  getUsername: () => string | undefined;
  codex?: CodexAuthService;
  getIntegrationStatus?: () => { git: string; provider: string; repository: string; worker: string };
  database?: AppDatabase;
  publicUrl?: string;
  logger?: Logger;
  contextRefresh?: (chatId: string, progress?: ProgressReporter) => Promise<string>;
  repositoryRefresh?: (chatId: string, progress?: ProgressReporter) => Promise<string>;
  getContextMode?: () => string;
  repositorySetup?: RepositorySetupService;
};

type Button = { text: string; callback_data: string };

export async function registerCommands(bot: Bot, options: CommandOptions): Promise<void> {
  bot.command("start", async (context) => {
    options.logger?.info("telegram.command_received", { command: "start", chat_id: context.chat?.id, user_id: context.from?.id });
    if (!isOwner(context.from?.id, options.ownerTelegramId)) return void await context.reply("Minishop Helper настроен. Управление доступно только владельцу.");
    if (context.chat?.type !== "private") return void await context.reply("Откройте личный чат с ботом и нажмите /start.");
    await sendMainMenu(context, options, `Minishop Helper запущен.\n\n${await statusMessage(options)}`);
  });

  bot.on("callback_query:data", async (context, next: NextFunction) => {
    const token = context.callbackQuery.data.match(/^s:([A-Za-z0-9_-]+)$/)?.[1];
    if (!token) return next();
    await answer(context, options);
    if (!isOwner(context.from?.id, options.ownerTelegramId) || context.chat?.type !== "private") return void await editCurrent(context, "Недостаточно прав.");
    if (!options.database) return void await editCurrent(context, "Хранилище недоступно.");
    let action;
    try {
      action = await consumeSetupAction(options.database, token, { ownerTelegramId: options.ownerTelegramId, chatId: String(context.chat.id), messageId: context.callbackQuery.message?.message_id });
    } catch (error) {
      const code = error instanceof SetupActionError ? error.code : "ACTION_INVALID";
      options.logger?.error("telegram.callback_failed", { ...safeErrorFields(error, "callback", { updateId: context.update.update_id, chatId: context.chat.id }), error_code: code, phase: "consume" });
      return void await editCurrent(context, callbackReason(code), { inline_keyboard: [[await actionButton(options, String(context.chat.id), "Обновить меню", "menu", context.callbackQuery.message?.message_id)]] });
    }
    try {
      await dispatchAction(context, options, action.flow);
    } catch (error) {
      const errorCode = callbackErrorCode(error, action.flow);
      options.logger?.error("telegram.callback_failed", { ...safeErrorFields(error, "callback", { updateId: context.update.update_id, chatId: context.chat.id }), flow: action.flow.split(":", 1)[0], error_code: errorCode, phase: "dispatch" });
      await editCurrent(context, callbackReason(errorCode), { inline_keyboard: [[await actionButton(options, String(context.chat.id), "Повторить", action.flow, context.callbackQuery.message?.message_id), await actionButton(options, String(context.chat.id), "Назад", "menu", context.callbackQuery.message?.message_id)]] });
    }
  });

  // This deliberately stays out of setMyCommands: it is only a setup fallback.
  bot.on("message:entities", async (context, next: NextFunction) => {
    if (!isLinkCommand(context.message, options.getUsername())) return next();
    await handleLinkCommand(context, bot, options);
  });

  await bot.api.setMyCommands([{ command: "start", description: "Открыть меню Minishop Helper" }]);
  options.logger?.info("telegram.commands_registered");
}

type CommandMessage = { text?: string; entities?: Array<{ type: string; offset: number; length: number }> };

export function isLinkCommand(message: CommandMessage | undefined, botUsername: string | undefined): boolean {
  if (!message?.text || !botUsername || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername)) return false;
  const entity = message.entities?.find((item) => item.type === "bot_command" && item.offset === 0);
  if (!entity) return false;
  const command = message.text.slice(0, entity.length);
  const match = command.match(/^\/link(?:@([A-Za-z0-9_]{5,32}))?$/i);
  return Boolean(match && (!match[1] || match[1].toLowerCase() === botUsername.toLowerCase()));
}

async function handleLinkCommand(context: Context, bot: Pick<Bot, "api">, options: CommandOptions): Promise<void> {
  if (context.chat?.type === "private") return void await context.reply("Эта команда работает только в группе. Вернитесь в нужную группу и отправьте указанную команду.");
  if (context.chat?.type !== "group" && context.chat?.type !== "supergroup") return;
  if (!isOwner(context.from?.id, options.ownerTelegramId)) {
    options.logger?.info("telegram.link_rejected", { reason: "not_owner", chat_id: context.chat.id, user_id: context.from?.id });
    return void await context.reply("Связать группу может только владелец настройки и администратор этой группы.");
  }
  if (!options.database || context.from?.id === undefined) return void await context.reply("Хранилище недоступно. Повторите позже.");
  const registry = new ChatRegistry(options.database);
  if (!await registry.registerLink(context, context.from.id, options.botTelegramId)) {
    options.logger?.info("telegram.link_rejected", { reason: "permissions", chat_id: context.chat.id, user_id: context.from.id });
    return void await context.reply("Нужны права администратора у вас и у бота в этой группе.");
  }
  let pending: ConsumedSetupSession;
  try {
    pending = consumePendingLink(options.database, options.ownerTelegramId);
  } catch (error) {
    const code = error instanceof PendingLinkError ? error.code : "LINK_MISSING";
    options.logger?.info("telegram.link_rejected", { reason: code, chat_id: context.chat.id, user_id: context.from.id });
    return void await context.reply(code === "LINK_AMBIGUOUS" ? "Найдено несколько незавершённых выборов. Вернитесь в личный чат с ботом и повторите выбор репозитория." : "Нет активного выбора репозитория или его срок истёк. Вернитесь в личный чат с ботом.");
  }
  const [repositoryId, encodedBranch] = pending.flow.slice("link:".length).split(":", 2);
  const branch = encodedBranch ? decodeBranch(encodedBranch) : undefined;
  const repositories = new RepositoryBindingRepository(options.database);
  const repository = repositories.getRepository(repositoryId);
  if (!repository || !repositories.listRepositories(options.ownerTelegramId).some((item) => item.id === repositoryId)) {
    options.logger?.info("telegram.link_rejected", { reason: "repository", chat_id: context.chat.id, user_id: context.from.id });
    return void await context.reply("Выбранный репозиторий больше недоступен. Выберите его заново в личном чате.");
  }
  if (encodedBranch && !branch) return void await context.reply("Выбранная ветка недействительна. Вернитесь в личный чат с ботом и повторите настройку.");
  repositories.bind(String(context.chat.id), repository.id, options.ownerTelegramId, branch);
  const notified = await notifyLinkComplete(bot, options, pending, repository.provider, repository.providerRepositoryId);
  options.logger?.info("telegram.link_accepted", { chat_id: context.chat.id, user_id: context.from.id, notified });
  try { await context.deleteMessage(); } catch { /* Telegram may deny deletion despite an administrator status. */ }
}

async function notifyLinkComplete(bot: Pick<Bot, "api">, options: CommandOptions, pending: ConsumedSetupSession, provider: string, providerRepositoryId: string): Promise<boolean> {
  const text = "Группа зарегистрирована и привязана. Продолжите настройку в личном чате с ботом.";
  try {
    if (pending.originMessageId && options.database) {
      const refresh = await actionButton(options, pending.chatId, "Обновить список групп", `repository:${provider}:${providerRepositoryId}`, pending.originMessageId);
      await bot.api.editMessageText(Number(pending.chatId), pending.originMessageId, text, { reply_markup: { inline_keyboard: [[refresh]] } });
    } else {
      await bot.api.sendMessage(Number(pending.chatId), text);
    }
    return true;
  } catch (error) {
    options.logger?.error("telegram.link_notification_failed", safeErrorFields(error, "telegram_feedback", { chatId: pending.chatId }));
    return false;
  }
}

async function dispatchAction(context: Context, options: CommandOptions, flow: string): Promise<void> {
  if (flow === "menu") return void await sendMainMenu(context, options);
  if (flow === "status") return void await sendMainMenu(context, options, await statusMessage(options));
  if (flow === "codex:menu") return void await sendCodexMenu(context, options);
  if (flow === "codex:connect") return void await connectCodex(context, options);
  if (flow === "codex:status") {
    const text = options.codex ? `Codex: ${formatCodexStatus(await options.codex.readStatus())}.` : "Codex: не настроен.";
    return void await sendCodexMenu(context, options, text);
  }
  if (flow === "codex:logout") {
    if (!options.codex) return void await sendCodexMenu(context, options, "Codex: не настроен.");
    try { await options.codex.logout(); return void await sendCodexMenu(context, options, "Codex: выход выполнен."); }
    catch (error) {
      options.logger?.error("telegram.codex_action_failed", safeErrorFields(error, "codex", { updateId: context.update.update_id, chatId: context.chat?.id }));
      return void await sendCodexMenu(context, options, codexError(error));
    }
  }
  const oauth = flow.match(/^oauth:(github|gitlab)$/)?.[1];
  if (oauth) return void await connectProvider(context, options, oauth);
  if (flow === "repositories") return void await showRepositories(context, options);
  if (flow === "context:refresh") return void await refreshBindings(context, options, "context");
  if (flow === "repository:refresh") return void await refreshBindings(context, options, "repository");

  const repositorySelection = flow.match(/^repository:(github|gitlab):(.+)$/);
  if (repositorySelection) return void await selectRepository(context, options, repositorySelection[1]!, repositorySelection[2]!);
  const branchSelection = flow.match(/^branch:(github|gitlab):([^:]+):([A-Za-z0-9_-]+)$/);
  if (branchSelection) return void await selectBranch(context, options, branchSelection[1]!, branchSelection[2]!, branchSelection[3]!);
  const chatSelection = flow.match(/^chat:([^:]+):([A-Za-z0-9_-]+):(-?\d+)$/);
  if (chatSelection) return void await selectChat(context, options, chatSelection[1]!, chatSelection[2]!, chatSelection[3]!);
  throw new Error("Unknown setup action");
}

async function sendMainMenu(context: Context, options: CommandOptions, text = "Настройка Minishop Helper") {
  const keyboard = await actionRows(options, String(context.chat!.id), [
    [["Codex", "codex:menu"], ["Подключить GitHub", "oauth:github"]],
    [["Подключить GitLab", "oauth:gitlab"], ["Выбрать репозиторий", "repositories"]],
    [["Обновить контекст", "context:refresh"], ["Обновить репозиторий", "repository:refresh"]],
    [["Статус", "status"]],
  ], currentMessageId(context));
  await render(context, `${text}\n\nВсе действия выполняются кнопками.`, { inline_keyboard: keyboard });
}

async function sendCodexMenu(context: Context, options: CommandOptions, text = "Управление Codex") {
  const keyboard = await actionRows(options, String(context.chat!.id), [
    [["Подключить Codex", "codex:connect"], ["Статус Codex", "codex:status"]],
    [["Выйти из Codex", "codex:logout"], ["Назад", "menu"]],
  ], currentMessageId(context));
  await render(context, text, { inline_keyboard: keyboard });
}

async function connectCodex(context: Context, options: CommandOptions): Promise<void> {
  if (!options.codex) return void await sendCodexMenu(context, options, "Codex: не настроен.");
  try {
    await editCurrent(context, "⏳ Инициализирую вход в Codex...");
    const login = await options.codex.startBrowserLogin();
    if (options.database && currentMessageId(context)) await createSetupSession(options.database, { chatId: String(context.chat!.id), ownerTelegramId: options.ownerTelegramId, flow: "codex:login", originMessageId: currentMessageId(context) });
    await editCurrent(context, "Откройте авторизацию Codex в браузере.", { inline_keyboard: [[{ text: "Открыть Codex", url: login.authUrl }], [await actionButton(options, String(context.chat!.id), "Назад", "codex:menu", currentMessageId(context))]] });
    return;
  } catch {
    try {
      const login = await options.codex.startDeviceLogin();
      if (options.database && currentMessageId(context)) await createSetupSession(options.database, { chatId: String(context.chat!.id), ownerTelegramId: options.ownerTelegramId, flow: "codex:login", originMessageId: currentMessageId(context) });
      await editCurrent(context, `Откройте страницу авторизации и введите код ${login.userCode}.`, { inline_keyboard: [[{ text: "Открыть Codex", url: login.verificationUrl }], [await actionButton(options, String(context.chat!.id), "Назад", "codex:menu", currentMessageId(context))]] });
      return;
    } catch (error) {
      options.logger?.error("telegram.codex_action_failed", safeErrorFields(error, "codex", { updateId: context.update.update_id, chatId: context.chat?.id }));
      await sendCodexMenu(context, options, codexError(error));
    }
  }
}

async function connectProvider(context: Context, options: CommandOptions, provider: string): Promise<void> {
  if (!options.database || !options.publicUrl) return void await sendMainMenu(context, options, "Для OAuth требуется PUBLIC_URL и SQLite.");
  let publicUrl: URL;
  try { publicUrl = new URL(options.publicUrl); } catch { return void await sendMainMenu(context, options, "Для OAuth укажите корректный PUBLIC_URL."); }
  if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
    return void await sendMainMenu(context, options, "Для OAuth PUBLIC_URL должен использовать HTTP или HTTPS.");
  }
  const session = await createSetupSession(options.database, { chatId: String(context.chat!.id), ownerTelegramId: options.ownerTelegramId, flow: `oauth:${provider}`, originMessageId: context.callbackQuery?.message?.message_id ?? null });
  const url = new URL(`/auth/${provider}/start`, publicUrl);
  url.searchParams.set("token", session.token);
  const name = provider === "github" ? "GitHub" : "GitLab";
  if (publicUrl.protocol === "http:") {
    return void await editCurrent(context, `Откройте ссылку ${name} в браузере:\n${url.toString()}`, { inline_keyboard: [[await actionButton(options, String(context.chat!.id), "Назад", "menu", currentMessageId(context))]] });
  }
  await editCurrent(context, `Откройте ${name} для авторизации.`, { inline_keyboard: [[{ text: `Открыть ${name}`, url: url.toString() }], [await actionButton(options, String(context.chat!.id), "Назад", "menu", currentMessageId(context))]] });
}

async function showRepositories(context: Context, options: CommandOptions): Promise<void> {
  const database = options.database!;
  const stored = new RepositoryBindingRepository(database).listRepositories(options.ownerTelegramId).filter((repository) => repository.enabled);
  const providers = database.query<{ provider: string }, [number]>("SELECT provider FROM git_connections WHERE owner_telegram_id = ? AND credentials_encrypted IS NOT NULL").all(options.ownerTelegramId).map((row) => row.provider);
  const progress = progressFor(context);
  await progress("⏳ Запрашиваю список репозиториев...");
  const failures: unknown[] = [];
  const remote = options.repositorySetup ? (await Promise.all(providers.map(async (provider) => {
    try { return (await options.repositorySetup!.list(options.ownerTelegramId, provider, progress)).map((repository) => ({ provider, id: repository.id, fullName: repository.fullName })); }
    catch (error) {
      failures.push(error);
      options.logger?.error("telegram.repository_list_failed", { ...safeErrorFields(error, "provider", { updateId: context.update.update_id, chatId: context.chat?.id }), provider });
      return [];
    }
  }))).flat() : stored.map((repository) => ({ provider: repository.provider, id: repository.providerRepositoryId, fullName: repository.fullName }));
  if (providers.length > 0 && failures.length === providers.length) throw failures[0];
  if (!remote.length) return void await sendMainMenu(context, options, "Нет доступных репозиториев. Сначала подключите GitHub или GitLab кнопкой выше.");
  const rows: Button[][] = [];
  for (const repository of remote.slice(0, 50)) rows.push([await actionButton(options, String(context.chat!.id), `${repository.provider}: ${repository.fullName}`, `repository:${repository.provider}:${repository.id}`, currentMessageId(context))]);
  rows.push([await actionButton(options, String(context.chat!.id), "Обновить список", "repositories", currentMessageId(context)), await actionButton(options, String(context.chat!.id), "Назад", "menu", currentMessageId(context))]);
  await editCurrent(context, "Выберите репозиторий:", { inline_keyboard: rows });
}

async function selectRepository(context: Context, options: CommandOptions, provider: string, providerRepositoryId: string): Promise<void> {
  const repositories = new RepositoryBindingRepository(options.database!);
  const selection = options.repositorySetup
    ? await options.repositorySetup.listBranches(options.ownerTelegramId, provider, providerRepositoryId, progressFor(context))
    : (() => {
      const repository = repositories.listRepositories(options.ownerTelegramId, provider).find((item) => item.providerRepositoryId === providerRepositoryId);
      return repository?.defaultBranch ? { repository, branches: [repository.defaultBranch] } : undefined;
    })();
  const repository = selection?.repository;
  if (!repository) throw new Error("Repository unavailable");
  const branches = selection.branches.filter(isSafeBranch).slice(0, 50);
  if (!branches.length) throw new Error("Repository has no safe branches");
  const rows: Button[][] = [];
  for (const branch of branches) rows.push([await actionButton(options, String(context.chat!.id), branch, `branch:${provider}:${repository.id}:${encodeBranch(branch)}`, currentMessageId(context))]);
  rows.push([await actionButton(options, String(context.chat!.id), "Обновить список", `repository:${provider}:${providerRepositoryId}`, currentMessageId(context)), await actionButton(options, String(context.chat!.id), "Назад", "repositories", currentMessageId(context))]);
  await editCurrent(context, `Репозиторий: ${repository.fullName}\nВыберите ветку:`, { inline_keyboard: rows });
}

async function selectBranch(context: Context, options: CommandOptions, provider: string, repositoryId: string, encodedBranch: string): Promise<void> {
  const branch = decodeBranch(encodedBranch);
  if (!branch) throw new Error("Invalid branch");
  const repository = new RepositoryBindingRepository(options.database!).getRepository(repositoryId);
  if (!repository || repository.provider !== provider) throw new Error("Repository unavailable");
  const chats = new ChatRegistry(options.database!).listChats();
  if (!chats.length) {
    await createSetupSession(options.database!, { chatId: String(context.chat!.id), ownerTelegramId: options.ownerTelegramId, flow: `link:${repository.id}:${encodedBranch}`, originMessageId: currentMessageId(context) ?? null });
    const username = options.getUsername();
    const command = username && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ? `/link@${username}` : "/link";
    return void await editCurrent(context, `Нет доступных групп. Telegram Bot API не перечисляет все группы. Добавьте бота в нужную группу, назначьте бота и владельца администраторами, затем отправьте там команду ${command}. Текст сообщения не сохраняется.`, { inline_keyboard: [[await actionButton(options, String(context.chat!.id), "Обновить список групп", `branch:${provider}:${repository.id}:${encodedBranch}`, currentMessageId(context)), await actionButton(options, String(context.chat!.id), "Назад", `repository:${provider}:${repository.providerRepositoryId}`, currentMessageId(context))]] });
  }
  const rows: Button[][] = [];
  for (const chat of chats) rows.push([await actionButton(options, String(context.chat!.id), chat.title, `chat:${repository.id}:${encodedBranch}:${chat.chatId}`)]);
  rows.push([await actionButton(options, String(context.chat!.id), "Обновить список", `branch:${provider}:${repository.id}:${encodedBranch}`), await actionButton(options, String(context.chat!.id), "Назад", `repository:${provider}:${repository.providerRepositoryId}`)]);
  await editCurrent(context, `Репозиторий: ${repository.fullName}\nВетка: ${branch}\nВыберите целевую группу:`, { inline_keyboard: rows });
}

async function selectChat(context: Context, options: CommandOptions, repositoryId: string, encodedBranch: string, chatId: string): Promise<void> {
  const branch = decodeBranch(encodedBranch);
  if (!branch) throw new Error("Invalid branch");
  const registry = new ChatRegistry(options.database!);
  const chat = registry.getChat(chatId);
  if (!chat) throw new Error("Chat unavailable");
  const [bot, owner] = await Promise.all([context.api.getChatMember(chatId, options.botTelegramId), context.api.getChatMember(chatId, options.ownerTelegramId)]);
  if (!isAdministratorStatus(bot.status) || !isAdministratorStatus(owner.status)) throw new Error("Chat permissions changed");
  if (chatId === String(options.ownerTelegramId) || Number(chatId) >= 0) throw new Error("Private chats cannot be bound");
  new RepositoryBindingRepository(options.database!).bind(chatId, repositoryId, options.ownerTelegramId, branch);
  const repository = new RepositoryBindingRepository(options.database!).getRepository(repositoryId)!;
  await sendMainMenu(context, options, `✅ Готово: ${repository.fullName}, ветка ${branch}, привязан к группе «${chat.title}».`);
}

async function refreshBindings(context: Context, options: CommandOptions, kind: "context" | "repository"): Promise<void> {
  const refresh = kind === "context" ? options.contextRefresh : options.repositoryRefresh;
  if (!refresh) return void await sendMainMenu(context, options, kind === "context" ? "Обновление контекста недоступно." : "Обновление локального репозитория недоступно.");
  const chats = options.database!.query<{ chat_id: string }, []>("SELECT DISTINCT chat_id FROM chat_bindings").all();
  if (!chats.length) return void await sendMainMenu(context, options, "Сначала выберите репозиторий и целевую группу.");
  const progress = progressFor(context);
  const results = await Promise.all(chats.map(async ({ chat_id }) => {
    try { return await refresh(chat_id, progress); } catch (error) {
      options.logger?.error("telegram.refresh_failed", safeErrorFields(error, kind === "repository" ? "checkout" : "codex", { updateId: context.update.update_id, chatId: chat_id }));
      return `Чат ${chat_id}: обновление не удалось. Проверьте настройки и повторите.`;
    }
  }));
  await sendMainMenu(context, options, results.join("\n"));
}

async function actionRows(options: CommandOptions, chatId: string, rows: Array<Array<[string, string]>>, originMessageId?: number): Promise<Button[][]> {
  return Promise.all(rows.map((row) => Promise.all(row.map(([text, flow]) => actionButton(options, chatId, text, flow, originMessageId)))));
}

async function actionButton(options: CommandOptions, chatId: string, text: string, flow: string, originMessageId?: number): Promise<Button> {
  if (!options.database) return { text, callback_data: "s:unavailable" };
  const session = await createSetupSession(options.database, { chatId, ownerTelegramId: options.ownerTelegramId, flow, originMessageId });
  return { text, callback_data: `s:${session.action}` };
}

async function answer(context: Context, options: CommandOptions, text?: string): Promise<void> {
  try { await context.answerCallbackQuery(text ? { text } : undefined); } catch (error) {
    if (!isExpectedTelegramError(error)) options.logger?.error("telegram.callback_answer_failed", safeErrorFields(error, "telegram_feedback", { updateId: context.update.update_id, chatId: context.chat?.id }));
  }
}

function currentMessageId(context: Context): number | undefined { return context.callbackQuery?.message?.message_id; }

async function render(context: Context, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  if (currentMessageId(context) !== undefined) return void await editCurrent(context, text, replyMarkup);
  await context.reply(text.slice(0, 4096), replyMarkup ? { reply_markup: replyMarkup as never } : undefined);
}

async function editCurrent(context: Context, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  const messageId = currentMessageId(context);
  if (!context.chat || messageId === undefined) return void await context.reply(text.slice(0, 4096), replyMarkup ? { reply_markup: replyMarkup as never } : undefined);
  try {
    await context.api.editMessageText(context.chat.id, messageId, text.slice(0, 4096), replyMarkup ? { reply_markup: replyMarkup as never } : undefined);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("message is not modified")) return;
    if (error instanceof Error && (error.message.toLowerCase().includes("message not found") || error.message.toLowerCase().includes("message to edit not found"))) {
      await context.reply(text.slice(0, 4096), replyMarkup ? { reply_markup: replyMarkup as never } : undefined);
      return;
    }
    throw error;
  }
}

function progressFor(context: Context): ProgressReporter {
  return throttledProgress((status) => editCurrent(context, status), 750);
}

function callbackErrorCode(error: unknown, flow: string): string {
  if (error instanceof SetupActionError) return error.code;
  if (error instanceof Error && error.message === "Provider did not return branches or a default branch") return "BRANCHES_UNAVAILABLE";
  if (/^repository:/.test(flow)) return "REPOSITORY_SELECTION_FAILED";
  if (/^(branch:|chat:)/.test(flow)) return "CHAT_SELECTION_FAILED";
  if (/^oauth:/.test(flow)) return "OAUTH_START_FAILED";
  if (/^codex:/.test(flow)) return "CODEX_ACTION_FAILED";
  return error instanceof Error && error.name !== "Error" ? error.name : "CALLBACK_ACTION_FAILED";
}

function encodeBranch(branch: string): string { return Buffer.from(branch).toString("base64url"); }
function decodeBranch(encoded: string): string | undefined {
  try { const branch = Buffer.from(encoded, "base64url").toString(); return isSafeBranch(branch) ? branch : undefined; } catch { return undefined; }
}
function isSafeBranch(value: string): boolean { return !value.startsWith("-") && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) && !value.includes("..") && !value.endsWith("/"); }

function callbackReason(code: string): string {
  if (code === "ACTION_REPLAYED") return "Это действие уже выполнено. Обновите меню.";
  if (code === "ACTION_WRONG_CONTEXT") return "Кнопка относится к другому сообщению или чату. Обновите меню.";
  if (code === "ACTION_EXPIRED" || code === "ACTION_INVALID") return "Срок действия кнопки истёк. Обновите меню.";
  if (code === "REPOSITORY_SELECTION_FAILED") return "Не удалось проверить выбранный репозиторий. Проверьте подключение provider и повторите.";
  if (code === "BRANCHES_UNAVAILABLE") return "Provider не вернул доступные ветки и ветку по умолчанию. Проверьте доступ к репозиторию или выберите другой.";
  if (code === "CHAT_SELECTION_FAILED") return "Не удалось проверить права в выбранной группе. Проверьте администраторов и повторите.";
  return "Не удалось выполнить действие. Код: " + code + ". Повторите или вернитесь в меню.";
}

async function statusMessage(options: CommandOptions): Promise<string> {
  const username = options.getUsername();
  let codex: CodexAccountStatus = { state: "unavailable" };
  let integration = { git: "not configured", provider: "not configured", repository: "not configured", worker: "not configured" };
  try {
    if (options.codex) codex = await options.codex.readStatus();
    integration = options.getIntegrationStatus?.() ?? integration;
  } catch (error) {
    options.logger?.error("telegram.status_read_failed", safeErrorFields(error, "callback"));
  }
  return [
    `Telegram: ${formatStatusValue(options.getStatus())}${username ? ` (@${username})` : ""}`,
    `Codex: ${formatCodexStatus(codex)}`,
    `Git: ${formatStatusValue(integration.git)}`,
    `Provider: ${formatStatusValue(integration.provider)}`,
    `Репозиторий: ${formatStatusValue(integration.repository)}`,
    `Режим контекста: ${options.getContextMode?.() ?? "не настроен"}`,
    `Обработчик: ${formatStatusValue(integration.worker)}`,
  ].join("\n");
}

function codexError(error: unknown): string {
  if (error instanceof CodexAuthError) return `Codex: ${error.code === "CODEX_LOGIN_DISABLED" ? "вход по device code отключён" : "требуется авторизация"}.`;
  return "Codex сейчас недоступен.";
}

function formatCodexStatus(status: CodexAccountStatus): string {
  if (status.state === "connected") return `подключён${maskAccount(status).slice("connected".length)}`;
  return status.state === "authorization_required" ? "требуется авторизация" : "недоступен";
}

function formatStatusValue(value: string): string {
  return ({ starting: "запускается", ready: "готов", failed: "сбой", not_configured: "не настроен", "not configured": "не настроен", connected: "подключён", configured: "настроен", running: "работает" })[value] ?? value;
}
