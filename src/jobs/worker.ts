import { type CreatedIssue } from "../git/types";
import { GitProviderError } from "../git/types";
import type { Logger } from "../logger";
import { generateNormalizedIssue, type IssueJobData, type ProcessIssueDependencies } from "./process-issue";
import { JobQueue } from "./queue";
import { CodexAuthError } from "../codex/auth";
import { isTelegramMessageNotFound, PreviewRepository, previewText } from "../telegram/previews";
import { CredentialError } from "../storage/git-credentials";
import { throttledProgress } from "../progress";
import { classifyError, isExpectedTelegramError, safeErrorFields } from "../telegram/errors";
import type { TelegramIssueRequestData } from "../telegram/request-handler";

export class IssueWorker {
  private timer?: Timer;
  private stopped = true;
  private running?: Promise<unknown>;
  constructor(
    private readonly queue: JobQueue,
    private readonly dependencies: ProcessIssueDependencies,
    private readonly options: { pollIntervalMs?: number; logger?: Logger; telegram?: TelegramFeedback } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.queue.recoverStaleLocks();
    void this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<CreatedIssue | undefined> {
    this.queue.recoverStaleLocks();
    const claimed = this.queue.claimNext<unknown, IssueJobData>();
    if (!claimed) return undefined;
    let progressMessageId: number | undefined;
    try {
      if (!this.options.telegram) throw new Error("Telegram preview transport is not configured");
      const previews = new PreviewRepository(this.queue.getDatabase());
      const existing = previews.get(claimed.request.id);
      progressMessageId = existing?.previewMessageId ?? (await (this.options.telegram.sendProgress?.(claimed.request.chatId, "⏳ Готовлю предпросмотр Issue...", claimed.request.messageThreadId, claimed.request.sourceMessageId)
        ?? this.options.telegram.sendPreview(claimed.request.chatId, "⏳ Готовлю предпросмотр Issue...", claimed.request.id, claimed.request.messageThreadId, claimed.request.sourceMessageId))).message_id;
      const progress = throttledProgress(async (status) => {
        const targetMessageId = previews.get(claimed.request.id)?.previewMessageId ?? progressMessageId!;
        try {
          await this.options.telegram!.editMessageText(claimed.request.chatId, targetMessageId, status, claimed.request.messageThreadId, claimed.request.sourceMessageId);
          progressMessageId = targetMessageId;
        } catch (error) {
          if (!isTelegramMessageNotFound(error)) throw error;
          const replacement = await this.options.telegram!.sendPreviewRecovery(claimed.request.chatId, "Предпросмотр был удалён. Создать новый?", claimed.request.id, claimed.request.messageThreadId, claimed.request.sourceMessageId);
          if (previews.replacePresentation(claimed.request.id, targetMessageId, replacement.message_id, previews.get(claimed.request.id)?.imageMessageIds ?? [])) progressMessageId = replacement.message_id;
          else await this.options.telegram!.deleteMessage?.(claimed.request.chatId, replacement.message_id).catch(() => undefined);
        }
      }, 750);
      const generated = await generateNormalizedIssue(claimed.job.data, { ...this.dependencies, progress });
      const { issue, usage } = generated;
      if (existing?.status === "regenerating") {
        if (!previews.updateGenerated(claimed.request.id, issue, usage, claimed.job.data.images)) throw new Error("Clarification state changed while generating");
        const refreshed = previews.get(claimed.request.id);
        if (!refreshed?.previewMessageId) throw new Error("Preview message is missing after generation");
        try {
          await this.options.telegram.editPreview(refreshed.chatId, refreshed.previewMessageId, previewText(refreshed), claimed.job.data.images, claimed.request.id, refreshed.messageThreadId, refreshed.sourceMessageId);
           await this.deleteClarificationMessage(claimed.request.chatId, claimed.job.data.clarificationMessageId);
           await this.options.telegram.cleanupLegacyPreviewImages(refreshed.chatId, refreshed.imageMessageIds);
           previews.replacePresentation(claimed.request.id, refreshed.previewMessageId, refreshed.previewMessageId, []);
        } catch (error) {
          if (!isTelegramMessageNotFound(error)) throw error;
          const replacement = await this.options.telegram.sendPreviewRecovery(refreshed.chatId, "Предпросмотр был удалён. Создать новый?", claimed.request.id, refreshed.messageThreadId, refreshed.sourceMessageId);
          if (!previews.replacePresentation(claimed.request.id, refreshed.previewMessageId, replacement.message_id, refreshed.imageMessageIds ?? [])) await this.options.telegram.deleteMessage?.(refreshed.chatId, replacement.message_id).catch(() => undefined);
        }
      } else {
        previews.create({ requestId: claimed.request.id, issue, usage, images: claimed.job.data.images, chatId: claimed.request.chatId, messageThreadId: claimed.request.messageThreadId, sourceMessageId: claimed.request.sourceMessageId, createdBy: (claimed.request.data as { telegramUserId?: number }).telegramUserId });
        previews.replacePresentation(claimed.request.id, undefined, progressMessageId, []);
        try {
          await this.options.telegram.editPreview(claimed.request.chatId, progressMessageId, previewText({ requestId: claimed.request.id, issue, usage, status: "pending_confirmation", chatId: claimed.request.chatId, messageThreadId: claimed.request.messageThreadId }), claimed.job.data.images, claimed.request.id, claimed.request.messageThreadId, claimed.request.sourceMessageId);
          await this.deleteInputMessage(claimed.request.chatId, (claimed.request.data as Partial<TelegramIssueRequestData>).incomingMessageId, claimed.request.id);
        } catch (error) {
          if (!isTelegramMessageNotFound(error)) throw error;
          const replacement = await this.options.telegram.sendPreviewRecovery(claimed.request.chatId, "Предпросмотр был удалён. Создать новый?", claimed.request.id, claimed.request.messageThreadId, claimed.request.sourceMessageId);
          if (!previews.replacePresentation(claimed.request.id, progressMessageId, replacement.message_id, [])) await this.options.telegram.deleteMessage?.(claimed.request.chatId, replacement.message_id).catch(() => undefined);
        }
      }
      this.queue.completePreview(claimed.job.id);
      return undefined;
    } catch (error) {
      rememberJobContext(error, claimed.request.id, claimed.request.chatId, claimed.job.data);
      let status: "queued" | "failed" | "needs_recovery" = "failed";
      if (isRetryable(error)) {
        status = this.queue.retry(claimed.job.id, persistedError(error), providerSupportsReconciliation(this.dependencies));
      } else {
        this.queue.fail(claimed.job.id, persistedError(error));
      }
      const feedback = status === "queued" ? `${feedbackError(error)} Запрос будет повторён автоматически.` : status === "needs_recovery" ? "Результат запроса к Git provider неизвестен. Автоматический повтор остановлен, чтобы не создать дубликат. Обратитесь к владельцу бота." : feedbackError(error);
      if (progressMessageId !== undefined) await this.updateFeedback(claimed.request.chatId, progressMessageId, feedback, claimed.request.messageThreadId, claimed.request.sourceMessageId, claimed.request.id);
      else await this.sendFeedback(claimed.request.chatId, feedback, claimed.request.messageThreadId, claimed.request.sourceMessageId, claimed.request.id);
      throw error;
    }
  }

  private async poll(): Promise<void> {
    try {
      this.running = this.runOnce();
      await this.running;
    } catch (error) {
      this.options.logger?.error("worker.job_failed", workerErrorFields(error));
    } finally {
      this.running = undefined;
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.options.pollIntervalMs ?? 1_000);
    }
  }

  private async sendFeedback(chatId: string, text: string, messageThreadId?: number, replyToMessageId?: number, requestId?: string): Promise<number | undefined> {
    try {
      const message = this.options.telegram?.sendProgress
        ? await this.options.telegram.sendProgress(chatId, text, messageThreadId, replyToMessageId)
        : await this.options.telegram?.sendMessage(chatId, text);
      return message?.message_id;
    } catch (error) {
      if (!isExpectedTelegramError(error)) this.options.logger?.error("worker.feedback_failed", safeErrorFields(error, "telegram_feedback", { requestId, chatId }));
      return undefined;
    }
  }

  private async updateFeedback(chatId: string, messageId: number | undefined, text: string, messageThreadId?: number, replyToMessageId?: number, requestId?: string): Promise<void> {
    if (messageId === undefined) return;
    try {
      await this.options.telegram?.editMessageText(chatId, messageId, text, messageThreadId, replyToMessageId);
    } catch (error) {
      if (isExpectedTelegramError(error)) {
        await this.sendFeedback(chatId, text, messageThreadId, replyToMessageId, requestId);
        return;
      }
      this.options.logger?.error("worker.feedback_failed", safeErrorFields(error, "telegram_feedback", { requestId, chatId }));
      await this.sendFeedback(chatId, text, messageThreadId, replyToMessageId, requestId);
    }
  }

  private async deleteClarificationMessage(chatId: string, messageId: number | undefined): Promise<void> {
    if (messageId === undefined) return;
    try { await this.options.telegram?.deleteMessage?.(chatId, messageId); } catch (error) {
      if (!isExpectedTelegramError(error)) this.options.logger?.error("worker.clarification_delete_failed", safeErrorFields(error, "telegram_feedback", { chatId }));
    }
  }

  private async deleteInputMessage(chatId: string, messageId: number | undefined, requestId: string): Promise<void> {
    if (messageId === undefined) return;
    try { await this.options.telegram?.deleteMessage?.(chatId, messageId); } catch (error) {
      if (!isExpectedTelegramError(error)) this.options.logger?.error("worker.input_delete_failed", safeErrorFields(error, "telegram_feedback", { requestId, chatId }));
    }
  }
}


export type TelegramFeedback = {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  editMessageText(chatId: string, messageId: number, text: string, messageThreadId?: number, replyToMessageId?: number): Promise<unknown>;
  sendProgress?(chatId: string, text: string, messageThreadId?: number, replyToMessageId?: number): Promise<{ message_id: number }>;
  sendPreview(chatId: string, text: string, requestId: string, messageThreadId?: number, replyToMessageId?: number): Promise<{ message_id: number }>;
  sendPreviewRecovery(chatId: string, text: string, requestId: string, messageThreadId?: number, replyToMessageId?: number): Promise<{ message_id: number }>;
  editPreview(chatId: string, messageId: number, text: string, images: IssueJobData["images"], requestId: string, messageThreadId?: number, replyToMessageId?: number): Promise<unknown>;
  cleanupLegacyPreviewImages(chatId: string, messageIds: number[] | undefined): Promise<void>;
  deleteMessage?(chatId: string, messageId: number): Promise<unknown>;
};

function feedbackError(error: unknown): string {
  if (error instanceof CredentialError) {
    return "Не удалось создать Issue: сохраненные credentials Git provider нельзя прочитать. Восстановите исходный APP_ENCRYPTION_KEY или переподключите Git provider.";
  }
  if (error instanceof CodexAuthError && error.code === "authorization_required") return "Не удалось создать Issue: требуется авторизация Codex. Попросите владельца открыть /start и нажать «Подключить Codex».";
  if (error instanceof GitProviderError) {
    if (error.code === "unauthorized" || error.code === "forbidden") return "Не удалось создать Issue: требуется повторно подключить Git-доступ.";
    if (error.code === "rate_limited") return "Не удалось создать Issue: Git provider ограничил запросы. Повторите позже.";
    return "Не удалось создать Issue: Git provider сейчас недоступен.";
  }
  return "Не удалось создать Issue: Codex не смог обработать запрос. Повторите позже.";
}

function persistedError(error: unknown): string {
  if (error instanceof CredentialError) return error.code;
  if (error instanceof CodexAuthError) return `CODEX_AUTH_${error.code.toUpperCase()}`;
  if (error instanceof GitProviderError) return `GIT_PROVIDER_${error.code.toUpperCase()}`;
  return "ISSUE_PROCESSING_FAILED";
}

export function workerErrorFields(error: unknown): Record<string, unknown> {
  const context = error && typeof error === "object" ? jobErrorContexts.get(error) : undefined;
  const jobFields = context ? { provider: context.provider, owner: context.owner, repository: context.repository, request_id: context.requestId, chat_id: context.chatId } : {};
  if (error instanceof CredentialError) {
    return {
      ...jobFields,
      error_code: error.code,
      provider: error.provider,
      owner_telegram_id: error.ownerTelegramId,
      phase: error.phase,
    };
  }
  if (error instanceof GitProviderError) return { ...jobFields, error_code: `GIT_PROVIDER_${error.code.toUpperCase()}`, phase: "provider_request" };
  if (error instanceof CodexAuthError) return { ...jobFields, error_code: `CODEX_AUTH_${error.code.toUpperCase()}`, phase: "codex_auth" };
  const safe = classifyError(error, "worker");
  return { ...jobFields, error_code: "ISSUE_PROCESSING_FAILED", phase: "issue_processing", reason: safe.reason, retryable: safe.retryable };
}

const jobErrorContexts = new WeakMap<object, { provider: string; owner: string; repository: string; requestId: string; chatId: string }>();

function rememberJobContext(error: unknown, requestId: string, chatId: string, job: IssueJobData): void {
  if (!error || typeof error !== "object") return;
  jobErrorContexts.set(error, {
    provider: error instanceof CredentialError ? error.provider : "unknown",
    owner: job.repository.owner,
    repository: job.repository.fullName,
    requestId,
    chatId,
  });
}

function isRetryable(error: unknown): boolean {
  return error instanceof GitProviderError && (error.code === "network" || error.code === "timeout" || error.code === "rate_limited" || error.code === "api" && (error.status === undefined || error.status >= 500));
}

function providerSupportsReconciliation(dependencies: ProcessIssueDependencies): boolean {
  return Boolean(dependencies.providerForRepository || dependencies.provider.findIssueByMarker);
}
