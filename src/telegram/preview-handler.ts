import type { Context } from "grammy";
import type { AppDatabase } from "../storage/db";
import type { GitProvider } from "../git/provider";
import type { IssueJobData } from "../jobs/process-issue";
import { isTelegramMessageNotFound, PreviewRepository, previewText, type StoredPreview } from "./previews";
import { isChatAdministrator, isOwner } from "./guards";
import { editInTopic, topicOptions } from "./topic";
import { editRichMessage, sendRichMessage } from "./rich-message";
import { cleanupLegacyPreviewImages } from "./preview-images";
import type { Logger } from "../logger";
import { classifyError, isExpectedTelegramError, notifyTelegramError, safeErrorFields } from "./errors";
import { JobQueue } from "../jobs/queue";

type PreviewCallbackOptions = { database: AppDatabase; ownerTelegramId: number; providerForRepository: (job: IssueJobData) => Promise<Pick<GitProvider, "createIssue" | "findIssueByMarker">>; logger?: Logger };

export async function handlePreviewCallback(context: Context, options: PreviewCallbackOptions): Promise<void> {
  try {
    await processPreviewCallback(context, options);
  } catch (error) {
    const requestId = context.callbackQuery?.data?.match(/:([\w-]+)$/)?.[1];
    await notifyTelegramError(context, error, { phase: "callback", logger: options.logger, requestId, event: "telegram.callback_failed", answerCallback: true });
  }
}

async function processPreviewCallback(context: Context, options: PreviewCallbackOptions): Promise<void> {
  const match = context.callbackQuery?.data?.match(/^(confirm|reject|clarify|cancel_clarify|recreate_preview):([\w-]+)$/);
  if (!match || !context.callbackQuery?.message || !context.chat || !context.from) return;
  const [, action, requestId] = match;
  const previews = new PreviewRepository(options.database);
  const preview = previews.get(requestId!);
  const message = context.callbackQuery.message;
  if (!preview || preview.chatId !== String(context.chat.id) || preview.messageThreadId !== message.message_thread_id) return void await context.answerCallbackQuery({ text: "Предпросмотр не найден." });
  if (action === "recreate_preview" ? !hasCallback(message, context.callbackQuery.data!) : preview.previewMessageId !== message.message_id) return void await context.answerCallbackQuery({ text: "Предпросмотр не найден." });
  if (!isOwner(context.from.id, options.ownerTelegramId) && !await isChatAdministrator(context)) return void await context.answerCallbackQuery({ text: "Недостаточно прав." });
  if (action === "recreate_preview") {
    const queue = new JobQueue(options.database);
    queue.recoverStaleLocks();
    const current = previews.get(requestId!);
    if (current?.status === "regenerating" && queue.hasActiveJob(requestId!)) {
      if (previews.replacePresentation(requestId!, current.previewMessageId, message.message_id, [])) {
        await cleanupLegacyPreviewImages(context.api, current.chatId, current.imageMessageIds);
      }
      try {
        await editRichMessage(context.api, current.chatId, message.message_id, "Предпросмотр обновляется. Сообщение будет заменено после завершения.", { ...topicOptions(current.messageThreadId, current.sourceMessageId), reply_markup: { inline_keyboard: [] } });
      } catch { /* Worker will use the latest stored recovery message. */ }
      return void await context.answerCallbackQuery();
    }
    if (current?.status === "creating") return void await context.answerCallbackQuery({ text: "Issue уже создаётся. Дождитесь завершения." });
    if (!previews.recreate(requestId!)) {
      return void await context.answerCallbackQuery({ text: "Предпросмотр уже недоступен." });
    }
    const refreshed = previews.get(requestId!);
    if (!refreshed) return void await context.answerCallbackQuery({ text: "Предпросмотр не найден." });
    const replacement = await sendPreview(context, refreshed, requestId!);
    if (!replacement) return void await context.answerCallbackQuery({ text: "Не удалось отправить предпросмотр." });
    if (!previews.replacePresentation(requestId!, refreshed.previewMessageId, replacement.message_id, [])) {
      await context.api.deleteMessage(refreshed.chatId, replacement.message_id).catch(() => undefined);
      return void await context.answerCallbackQuery({ text: "Предпросмотр уже восстановлен." });
    }
    await cleanupLegacyPreviewImages(context.api, refreshed.chatId, refreshed.imageMessageIds);
    for (const staleMessageId of new Set([message.message_id, refreshed.previewMessageId])) {
      if (staleMessageId !== undefined && staleMessageId !== replacement.message_id) await context.api.deleteMessage(refreshed.chatId, staleMessageId).catch(() => undefined);
    }
    return void await context.answerCallbackQuery({ text: "Предпросмотр создан." });
  }
  if (action === "cancel_clarify") {
    if (!previews.transition(requestId!, "clarification_requested", "pending_confirmation")) return void await context.answerCallbackQuery({ text: "Уточнение уже обработано." });
    if (!await editOrOfferRecovery(context, previews, preview, requestId!, () => editRichMessage(context.api, preview.chatId, message.message_id, previewText(preview), { ...topicOptions(preview.messageThreadId, preview.sourceMessageId), reply_markup: { inline_keyboard: previewButtons(requestId!) } }, preview.images))) return void await context.answerCallbackQuery({ text: "Предпросмотр удалён. Можно создать новый." });
    return void await context.answerCallbackQuery({ text: "Уточнение отменено" });
  }
  if (action === "reject") {
    const purged = previews.purgeDraft(requestId!);
    if (!purged) return void await context.answerCallbackQuery({ text: "Уже обработано." });
    await context.answerCallbackQuery({ text: "Отклонено и удалено" });
    await deleteMessagesSafely(context, options, purged.chatId, requestId!, [purged.incomingMessageId, purged.previewMessageId, ...(purged.imageMessageIds ?? [])]);
    return;
  }
  if (action === "clarify") {
    if (!previews.transition(requestId!, "pending_confirmation", "clarification_requested")) return void await context.answerCallbackQuery({ text: "Уже обработано." });
    const text = `${previewText(preview)}\n\nДобавьте уточнение ответом на это сообщение с предпросмотром или на исходное сообщение. Повторно упоминать бота не требуется. Исходное сообщение может быть от любого участника группы.`;
    if (!await editOrOfferRecovery(context, previews, preview, requestId!, () => editRichMessage(context.api, preview.chatId, message.message_id, text, { ...topicOptions(preview.messageThreadId, preview.sourceMessageId), reply_markup: { inline_keyboard: [[{ text: "Отменить уточнение", callback_data: `cancel_clarify:${requestId}` }]] } }, preview.images))) return void await context.answerCallbackQuery({ text: "Предпросмотр удалён. Можно создать новый." });
    return void await context.answerCallbackQuery({ text: "Ожидается уточнение" });
  }
  if (!previews.transition(requestId!, "pending_confirmation", "creating")) return void await context.answerCallbackQuery({ text: "Уже обработано." });
  await context.answerCallbackQuery();
  let issuePersisted = false;
  let createdUrl: string | undefined;
  try {
    if (!await editOrOfferRecovery(context, previews, preview, requestId!, () => editInTopic(context.api, preview.chatId, message.message_id, "⏳ Создаю Issue...", preview.messageThreadId, preview.sourceMessageId, { reply_markup: { inline_keyboard: [] } }))) return;
    const job = options.database.query<{ job_data: string }, [string]>("SELECT job_data FROM jobs WHERE request_id = ?").get(requestId!);
    if (!job) throw new Error("Request job is missing");
    const data = JSON.parse(job.job_data) as IssueJobData;
    const provider = await options.providerForRepository(data);
    if (!await editOrOfferRecovery(context, previews, preview, requestId!, () => editInTopic(context.api, preview.chatId, message.message_id, "⏳ Проверяю существующий Issue у provider...", preview.messageThreadId, preview.sourceMessageId, { reply_markup: { inline_keyboard: [] } }))) return;
    const marker = `<!-- telegram-request-id: ${requestId} -->`;
    const created = await provider.findIssueByMarker?.(data.repository, marker) ?? await provider.createIssue(data.repository, { title: preview.issue.title, description: `${preview.issue.description}\n\n${marker}`, labels: preview.issue.labels, attachments: data.images });
    options.database.transaction(() => {
      options.database.query("UPDATE requests SET status = 'completed', issue_id = ?, issue_number = ?, issue_title = ?, issue_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(created.id, created.number, created.title, created.webUrl, requestId);
      const changed = options.database.query("UPDATE issue_previews SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'creating'").run(requestId).changes;
      if (changed !== 1) throw new Error("Preview creation state changed");
    })();
    issuePersisted = true;
    createdUrl = created.webUrl;
    try {
      await editInTopic(context.api, preview.chatId, message.message_id, `Issue создан: ${created.webUrl}`, preview.messageThreadId, preview.sourceMessageId, { reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (!isTelegramMessageNotFound(error)) throw error;
    }
    await deleteMessagesSafely(context, options, preview.chatId, requestId!, [preview.sourceMessageId], "telegram.source_delete_failed");
  } catch (error) {
    if (issuePersisted) {
      options.logger?.error("telegram.issue_feedback_failed", safeErrorFields(error, "telegram_feedback", { updateId: context.update.update_id, requestId, chatId: context.chat.id }));
      await deleteMessagesSafely(context, options, preview.chatId, requestId!, [preview.sourceMessageId], "telegram.source_delete_failed");
      await context.reply(`Issue создан${createdUrl ? `: ${createdUrl}` : ""}, но не удалось обновить предпросмотр. Не нажимайте «Повторить»; при необходимости откройте Issue по ссылке.`);
      return;
    }
    options.database.transaction(() => {
      const changed = options.database.query("UPDATE issue_previews SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'creating'").run(requestId).changes;
      if (changed) options.database.query("UPDATE requests SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
    })();
    const safe = classifyError(error, "provider");
    options.logger?.error("telegram.callback_failed", safeErrorFields(error, safe.phase, { updateId: context.update.update_id, requestId, chatId: context.chat.id }));
    await editOrOfferRecovery(context, previews, preview, requestId!, () => editRichMessage(context.api, preview.chatId, message.message_id, `${previewText(preview)}\n\nНе удалось создать Issue. ${safe.message}`, { ...topicOptions(preview.messageThreadId, preview.sourceMessageId), reply_markup: { inline_keyboard: [[{ text: "Повторить", callback_data: `confirm:${requestId}` }, { text: "Отклонить", callback_data: `reject:${requestId}` }]] } }, preview.images));
  }
}

async function deleteMessagesSafely(context: Context, options: PreviewCallbackOptions, chatId: string, requestId: string, messageIds: Array<number | undefined>, event = "telegram.preview_delete_failed"): Promise<void> {
  for (const messageId of new Set(messageIds.filter((value): value is number => value !== undefined))) {
    try { await context.api.deleteMessage(chatId, messageId); } catch (error) {
      if (!isExpectedTelegramError(error)) options.logger?.error(event, safeErrorFields(error, "telegram_feedback", { updateId: context.update.update_id, requestId, chatId }));
    }
  }
}

function previewButtons(requestId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[{ text: "Подтвердить", callback_data: `confirm:${requestId}` }, { text: "Отклонить", callback_data: `reject:${requestId}` }, { text: "Уточнить", callback_data: `clarify:${requestId}` }]];
}

async function editOrOfferRecovery(context: Context, previews: PreviewRepository, preview: StoredPreview, requestId: string, edit: () => Promise<unknown>): Promise<boolean> {
  try { await edit(); return true; } catch (error) {
    if (!isTelegramMessageNotFound(error)) throw error;
    previews.transition(requestId, "creating", "pending_confirmation") || previews.transition(requestId, "clarification_requested", "pending_confirmation");
    const current = previews.get(requestId);
    if (!current || current.previewMessageId !== preview.previewMessageId) return false;
    const replacement = await sendRecovery(context, preview, requestId);
    if (replacement && !previews.replacePresentation(requestId, current.previewMessageId, replacement.message_id, current.imageMessageIds ?? [])) {
      await context.api.deleteMessage(preview.chatId, replacement.message_id).catch(() => undefined);
    }
    return false;
  }
}

async function sendRecovery(context: Context, preview: StoredPreview, requestId: string): Promise<{ message_id: number } | undefined> {
  const options = { ...(preview.messageThreadId === undefined ? {} : { message_thread_id: preview.messageThreadId }), ...(preview.sourceMessageId === undefined ? {} : { reply_parameters: { message_id: preview.sourceMessageId } }), reply_markup: { inline_keyboard: [[{ text: "Восстановить предпросмотр", callback_data: `recreate_preview:${requestId}` }]] } };
  return context.api.sendMessage(preview.chatId, "Предпросмотр был удалён. Восстановить последний сохранённый предпросмотр?", options);
}

async function sendPreview(context: Context, preview: StoredPreview, requestId: string): Promise<{ message_id: number } | undefined> {
  return sendRichMessage(context.api, preview.chatId, previewText(preview), { ...topicOptions(preview.messageThreadId, preview.sourceMessageId), reply_markup: { inline_keyboard: previewButtons(requestId) } }, preview.images);
}

function hasCallback(message: NonNullable<Context["callbackQuery"]>["message"], callbackData: string): boolean {
  return message?.reply_markup?.inline_keyboard.some((row) => row.some((button) => "callback_data" in button && button.callback_data === callbackData)) ?? false;
}
