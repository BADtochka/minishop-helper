import type { Context } from "grammy";
import type { AppDatabase } from "../storage/db";
import { JobQueue } from "../jobs/queue";
import type { IssueJobData } from "../jobs/process-issue";
import type { GitRepository } from "../git/types";
import { RepositoryBindingRepository } from "../storage/repository-bindings";
import { isAcceptedMessage, isAcceptedNewRequest } from "./messages";
import { imageFileId, removeBotMention } from "./mentions";
import type { ImageAttachment } from "../jobs/process-issue";
import { ProjectContextStorage } from "../context/storage";
import { defaultProjectContext } from "../context/defaults";
import { PreviewRepository, type StoredPreview } from "./previews";
import { isChatAdministrator } from "./guards";
import type { Logger } from "../logger";
import { classifyError, notifyTelegramError, safeErrorFields, TelegramOperationError } from "./errors";

export type TelegramRequestHandlerOptions = {
  database: AppDatabase;
  queue: JobQueue;
  botUsername: string;
  ownerTelegramId: number;
  integrationsAvailable: boolean | (() => boolean);
  downloadTelegramImage?: (fileId: string) => Promise<ImageAttachment>;
  logger?: Logger;
};

export type TelegramIssueRequestData = {
  sourceText: string;
  adminComment: string;
  incomingMessageId: number;
  telegramUserId?: number;
};

export async function handleTelegramRequest(context: Context, options: TelegramRequestHandlerOptions): Promise<void> {
  try {
    await processTelegramRequest(context, options);
  } catch (error) {
    const phase = classifyError(error, "request").phase;
    await notifyTelegramError(context, error, { phase, logger: options.logger, event: "telegram.request_failed" });
  }
}

async function processTelegramRequest(context: Context, options: TelegramRequestHandlerOptions): Promise<void> {
  const message = context.msg ?? context.message;
  const chatId = context.chat?.id;
  if (!message || chatId === undefined || context.update.update_id === undefined) return;
  const replyReferences = clarificationReplyReferences(message, chatId);
  const replyIds = replyReferences.map(({ messageId }) => messageId);
  const previews = new PreviewRepository(options.database);
  const clarification = replyIds.map((replyId) => previews.findClarification(String(chatId), message.message_thread_id, replyId)).find(Boolean);
  const knownReply = clarification ?? replyIds.map((replyId) => previews.findByReply(String(chatId), replyId)).find(Boolean);
  const previewLikeReply = isPreviewLikeReply(message);
  const admin = (replyReferences.length > 0 || previewLikeReply) && await isChatAdministrator(context);
  const active = knownReply?.status === "creating" ? "creating" : knownReply?.status === "regenerating" && options.queue.hasActiveJob(knownReply.requestId) ? "regenerating" : undefined;
  const newRequest = !clarification && !active && admin && (Boolean(knownReply) || previewLikeReply) && await isAcceptedNewRequest(context, options.botUsername);

  if (clarification && !admin) {
    logClarificationFilter(options, context, replyIds, clarification.status, "not_administrator");
    return;
  }
  if (!clarification && admin && knownReply && !newRequest) {
    const status = knownReply?.status ?? "not_found";
    logClarificationFilter(options, context, replyIds, status, "not_awaiting_clarification", replyReferences.map(({ kind }) => kind));
    await offerPreviewRecovery(context, options, knownReply, recoveryComment(message, options.botUsername), active);
    return;
  }
  if (!clarification && admin && previewLikeReply && !newRequest) {
    logClarificationFilter(options, context, replyIds, "not_found", "unknown_preview_reply", replyReferences.map(({ kind }) => kind));
    await replySafely(context, options, "Этот предпросмотр больше недоступен. Для нового запроса добавьте описание и упоминание бота; для уточнения ответьте на актуальный предпросмотр.");
    return;
  }
  if (!clarification && !newRequest && !await isAcceptedMessage(context, options.botUsername, options.ownerTelegramId)) return;

  const directReply = message.reply_to_message;
  const currentText = message.text ?? message.caption ?? "";
  const contentComment = removeBotMention(currentText, options.botUsername);
  const sourceText = newRequest ? contentComment : directReply?.text ?? directReply?.caption ?? "";
  const adminComment = message.text ?? message.caption;
  const sourceImageId = newRequest ? imageFileId(message) : directReply && imageFileId(directReply);
  const clarificationImageId = imageFileId(message);
  if (clarification ? (!adminComment && !clarificationImageId) : ((!sourceText && !sourceImageId) || (!newRequest && !adminComment))) return;

  if (sourceText.length > 10_000 || (adminComment?.length ?? 0) > 4_096) {
    await replySafely(context, options, "Исходное сообщение или комментарий слишком длинные для безопасной обработки. Сократите текст и повторите.");
    return;
  }

  if (!(typeof options.integrationsAvailable === "function" ? options.integrationsAvailable() : options.integrationsAvailable)) {
    await replySafely(context, options, "Создание Issue недоступно: Codex или Git provider не настроен. Владелец может проверить подключения через /start.");
    return;
  }

  if (clarification) {
    const previous = options.database.query<{ job_data: string }, [string]>("SELECT job_data FROM jobs WHERE request_id = ? ORDER BY created_at DESC LIMIT 1").get(clarification.requestId);
    if (!previous) return void await replySafely(context, options, "Не удалось найти исходный запрос для уточнения. Создайте новый запрос.");
    const job = JSON.parse(previous.job_data) as IssueJobData;
    let clarificationImage: ImageAttachment | undefined;
    try {
      clarificationImage = clarificationImageId ? await downloadImage(clarificationImageId, options) : undefined;
    } catch (error) {
      if (error instanceof Error && error.message === "Telegram attachment is not an image") {
        await replySafely(context, options, "Вложение не является поддерживаемым изображением. Отправьте JPG, PNG или WebP и повторите.");
        return;
      }
      throw error;
    }
    const queued = options.queue.enqueueClarification(context.update.update_id, clarification.requestId, {
      ...job,
       prompt: `${job.prompt}${contentComment ? `\n\nAdministrator clarification:\n${contentComment}` : ""}`,
      ...(clarificationImage ? { images: [...(job.images ?? []), clarificationImage] } : {}),
      clarificationMessageId: message.message_id,
      projectContext: new ProjectContextStorage(options.database).get(job.repositoryId)?.context ?? job.projectContext,
    });
    return;
  }

  const repository = new RepositoryBindingRepository(options.database).resolveActive(String(chatId));
  if (!repository) {
    await replySafely(context, options, "К этому чату не привязан активный репозиторий. Владелец может выбрать репозиторий через /start.");
    return;
  }

  let sourceImage: ImageAttachment | undefined;
  try {
    sourceImage = sourceImageId ? await downloadImage(sourceImageId, options) : undefined;
  } catch (error) {
    if (error instanceof Error && error.message === "Telegram attachment is not an image") {
        await replySafely(context, options, "Вложение не является поддерживаемым изображением. Отправьте JPG, PNG или WebP и повторите.");
      return;
    }
    throw error;
  }
  let result: ReturnType<JobQueue["enqueue"]>;
  try {
    result = options.queue.enqueue({
    updateId: context.update.update_id,
      chatId: String(chatId),
    requestData: { sourceText, adminComment: adminComment!, incomingMessageId: message.message_id, telegramUserId: context.from?.id } satisfies TelegramIssueRequestData,
    messageThreadId: message.message_thread_id,
    sourceMessageId: newRequest ? undefined : message.reply_to_message?.message_id,
    jobData: {
      repositoryId: repository.id,
      repository: toGitRepository(repository),
        prompt: `Source message:\n${sourceText}${newRequest ? "" : contentComment ? `\n\nAdministrator comment:\n${contentComment}` : ""}`,
      ...(sourceImage ? { images: [sourceImage] } : {}),
      projectContext: new ProjectContextStorage(options.database).get(repository.id)?.context ?? defaultProjectContext(repository.fullName, repository.providerRepositoryId),
    } satisfies IssueJobData,
    });
  } catch (error) {
    throw new TelegramOperationError("enqueue", { cause: error });
  }
  // Telegram retries are expected; the queue transaction makes duplicate deliveries no-ops.
  if (result.duplicate) return;
}

async function offerPreviewRecovery(context: Context, options: TelegramRequestHandlerOptions, preview: StoredPreview, clarification: string, active: "regenerating" | "creating" | undefined): Promise<void> {
  const clarificationNotice = clarification.trim()
    ? active
      ? " Уточнение не принято: дождитесь обновлённого предпросмотра и отправьте его повторно."
      : " Уточнение не принято из-за текущего статуса. Восстановите предпросмотр, выберите «Уточнить» и отправьте его повторно."
    : "";
  const text = active === "regenerating"
    ? `Предпросмотр обновляется. Это сообщение будет заменено после завершения.${clarificationNotice}`
    : active === "creating"
      ? `Issue создаётся. Дождитесь завершения операции.${clarificationNotice}`
    : `Предпросмотр был удалён или его обновление прервалось. Восстановить последний сохранённый предпросмотр?${clarificationNotice}`;
  const notice = await replySafely(context, options, text, active ? undefined : {
    reply_markup: { inline_keyboard: [[{ text: "Восстановить предпросмотр", callback_data: `recreate_preview:${preview.requestId}` }]] },
  });
  if (!notice || active === "creating") return;
  const stored = new PreviewRepository(options.database);
  if (!stored.replacePresentation(preview.requestId, preview.previewMessageId, notice.message_id, preview.imageMessageIds ?? [])) {
    await context.api.deleteMessage(preview.chatId, notice.message_id).catch(() => undefined);
  }
}

function recoveryComment(message: NonNullable<Context["msg"]>, botUsername: string): string {
  const value = message.text ?? message.caption;
  if (!value) return "";
  const comment = removeBotMention(value, botUsername);
  return /[\p{L}\p{N}]/u.test(comment) || imageFileId(message) ? comment || "image" : "";
}

type ClarificationMessage = NonNullable<Context["msg"]> & {
  external_reply?: { chat?: { id: number }; message_id?: number };
  reply_parameters?: { chat_id?: number | string; message_id?: number; quote?: { message_id?: number; chat_id?: number | string } };
  quote?: { message_id?: number; chat_id?: number | string };
  rich_message?: unknown;
};

type ReplyReference = { messageId: number; kind: "reply_to_message" | "external_reply" | "reply_parameters" | "quote" };

function clarificationReplyReferences(message: ClarificationMessage, chatId: number): ReplyReference[] {
  const references: ReplyReference[] = [];
  const add = (messageId: number | undefined, kind: ReplyReference["kind"], referenceChatId?: number | string): void => {
    if (messageId === undefined || (referenceChatId !== undefined && String(referenceChatId) !== String(chatId))) return;
    if (!references.some((reference) => reference.messageId === messageId)) references.push({ messageId, kind });
  };
  add(message.reply_to_message?.message_id, "reply_to_message");
  if (message.external_reply?.chat?.id !== undefined) add(message.external_reply.message_id, "external_reply", message.external_reply.chat.id);
  add(message.reply_parameters?.message_id, "reply_parameters", message.reply_parameters?.chat_id);
  add(message.reply_parameters?.quote?.message_id, "quote", message.reply_parameters?.quote?.chat_id ?? message.reply_parameters?.chat_id);
  add(message.quote?.message_id, "quote", message.quote?.chat_id);
  return references;
}

function isPreviewLikeReply(message: ClarificationMessage): boolean {
  const replied = message.reply_to_message as (typeof message.reply_to_message & { rich_message?: unknown }) | undefined;
  if (replied?.rich_message) return true;
  const external = message.external_reply as (typeof message.external_reply & { rich_message?: unknown; reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) | undefined;
  if (external?.rich_message) return true;
  const buttons = replied?.reply_markup?.inline_keyboard ?? external?.reply_markup?.inline_keyboard;
  return buttons?.some((row) => row.some((button) => "callback_data" in button && button.callback_data?.startsWith("cancel_clarify:"))) ?? false;
}

function logClarificationFilter(options: TelegramRequestHandlerOptions, context: Context, replyIds: number[], status: string, reason: string, referenceKinds?: string[]): void {
  options.logger?.info("telegram.clarification_filtered", {
    update_id: context.update.update_id,
    update_type: context.update.guest_message ? "guest_message" : "message",
    chat_id: context.chat?.id,
    reply_ids: replyIds,
    ...(referenceKinds?.length ? { reference_kinds: referenceKinds } : {}),
    status,
    reason,
  });
}

async function downloadImage(fileId: string, options: TelegramRequestHandlerOptions): Promise<ImageAttachment> {
  if (!options.downloadTelegramImage) throw new Error("Telegram image download is not configured");
  return options.downloadTelegramImage(fileId);
}

function toGitRepository(row: { providerRepositoryId: string; fullName: string; webUrl: string | null; defaultBranch: string | null; branch: string | null }): GitRepository {
  const separator = row.fullName.lastIndexOf("/");
  const owner = separator === -1 ? "" : row.fullName.slice(0, separator);
  const name = separator === -1 ? row.fullName : row.fullName.slice(separator + 1);
  return { id: row.providerRepositoryId, owner, name, fullName: row.fullName, description: null, private: false, webUrl: row.webUrl ?? "", defaultBranch: row.branch ?? row.defaultBranch };
}

async function replySafely(context: Context, handlerOptions: TelegramRequestHandlerOptions, text: string, options?: Parameters<Context["reply"]>[1]): Promise<{ message_id: number } | undefined> {
  try {
    return await context.reply(text, options);
  } catch (error) {
    handlerOptions.logger?.error("telegram.feedback_failed", safeErrorFields(error, "telegram_feedback", { updateId: context.update.update_id, chatId: context.chat?.id }));
    return undefined;
  }
}
