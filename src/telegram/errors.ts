import type { Context } from "grammy";
import type { Logger } from "../logger";

export type TelegramErrorPhase =
  | "update"
  | "request"
  | "attachment"
  | "enqueue"
  | "callback"
  | "oauth"
  | "worker"
  | "provider"
  | "codex"
  | "checkout"
  | "preview"
  | "webhook"
  | "telegram_feedback";

export type SafeError = {
  code: string;
  phase: TelegramErrorPhase;
  reason: string;
  message: string;
  retryable: boolean;
  expected: boolean;
};

export class TelegramOperationError extends Error {
  constructor(readonly phase: TelegramErrorPhase, options?: ErrorOptions) {
    super(`Telegram operation failed during ${phase}`, options);
    this.name = "TelegramOperationError";
  }
}

export function classifyError(error: unknown, phase: TelegramErrorPhase): SafeError {
  const raw = errorText(error);
  const lower = raw.toLowerCase();
  if (error instanceof TelegramOperationError) return classifyErrorByPhase(error.phase, errorText(error.cause ?? error));
  if (lower.includes("message is not modified")) return known("TELEGRAM_MESSAGE_NOT_MODIFIED", phase, raw, "", false, true);
  if (lower.includes("message to edit not found") || lower.includes("message to delete not found") || lower.includes("message not found")) return known("TELEGRAM_MESSAGE_DELETED", phase, raw, "Предыдущее сообщение удалено. Бот попробует восстановить его новым сообщением.", false, true);
  if (lower.includes("query is too old") || lower.includes("query id is invalid")) return known("TELEGRAM_CALLBACK_EXPIRED", phase, raw, "", false, true);
  if (lower.includes("too large")) return known("ATTACHMENT_TOO_LARGE", "attachment", raw, "Не удалось загрузить изображение: файл слишком большой. Отправьте изображение размером до 10 МБ и повторите.", false);
  if (lower.includes("not an image") || lower.includes("unsupported image")) return known("ATTACHMENT_UNSUPPORTED", "attachment", raw, "Вложение не является поддерживаемым изображением. Отправьте JPG, PNG или WebP и повторите.", false);
  if (phase === "attachment" || lower.includes("image download") || lower.includes("file path")) return known("ATTACHMENT_DOWNLOAD_FAILED", "attachment", raw, "Не удалось загрузить изображение из Telegram. Отправьте его ещё раз или повторите запрос без изображения.", true);
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("authorization_required")) return known("AUTHORIZATION_REQUIRED", phase, raw, "Не удалось выполнить запрос: требуется повторная авторизация. Владелец может проверить подключения через /start.", false);
  if (lower.includes("rate limit")) return known("RATE_LIMITED", phase, raw, "Сервис временно ограничил запросы. Повторите позже.", true);
  if (lower.includes("timeout") || lower.includes("timed out")) return known("UPSTREAM_TIMEOUT", phase, raw, "Сервис не ответил вовремя. Повторите позже.", true);
  return classifyErrorByPhase(phase, raw);
}

export function safeErrorFields(error: unknown, phase: TelegramErrorPhase, context: {
  updateId?: number;
  requestId?: string;
  chatId?: string | number;
} = {}): Record<string, unknown> {
  const safe = classifyError(error, phase);
  return {
    error_code: safe.code,
    phase: safe.phase,
    ...(context.updateId === undefined ? {} : { update_id: context.updateId }),
    ...(context.requestId === undefined ? {} : { request_id: context.requestId }),
    ...(context.chatId === undefined ? {} : { chat_id: context.chatId }),
    reason: safe.reason,
    retryable: safe.retryable,
  };
}

export async function notifyTelegramError(context: Context, error: unknown, options: {
  phase: TelegramErrorPhase;
  logger?: Logger;
  requestId?: string;
  event?: string;
  answerCallback?: boolean;
}): Promise<boolean> {
  const safe = classifyError(error, options.phase);
  const ids = { updateId: context.update?.update_id, requestId: options.requestId, chatId: context.chat?.id };
  if (!safe.expected) options.logger?.error(options.event ?? "telegram.request_failed", safeErrorFields(error, options.phase, ids));
  if (safe.expected && !safe.message) return true;
  if (options.answerCallback && context.callbackQuery) {
    try { await context.answerCallbackQuery({ text: safe.message.slice(0, 200), show_alert: true }); } catch { /* Expired callbacks cannot be acknowledged. */ }
  }
  try {
    await context.reply(safe.message.slice(0, 4096));
    return true;
  } catch (deliveryError) {
    if (!isExpectedTelegramError(deliveryError)) options.logger?.error("telegram.feedback_failed", safeErrorFields(deliveryError, "telegram_feedback", ids));
    return false;
  }
}

export function isExpectedTelegramError(error: unknown): boolean {
  return classifyError(error, "telegram_feedback").expected;
}

export function redactErrorText(value: string): string {
  return value
    .replace(/\b(Bearer|token|secret|password|client_secret|access_token|refresh_token|api[_-]?key)\s*[:=]?\s*[^\s&,]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:code|state|token|secret|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try { const parsed = new URL(url); parsed.search = ""; parsed.hash = ""; return parsed.toString(); } catch { return "[REDACTED_URL]"; }
    })
    .slice(0, 240);
}

function known(code: string, phase: TelegramErrorPhase, reason: string, message: string, retryable: boolean, expected = false): SafeError {
  return { code, phase, reason: redactErrorText(reason) || code, message, retryable, expected };
}

function classifyErrorByPhase(phase: TelegramErrorPhase, reason: string): SafeError {
  if (phase === "oauth") return known("OAUTH_FAILED", phase, reason, "Не удалось завершить авторизацию. Вернитесь в Telegram, проверьте настройки подключения и повторите.", false);
  if (phase === "enqueue") return known("QUEUE_FAILED", phase, reason, "Не удалось поставить запрос в очередь. Повторите запрос; если ошибка сохранится, обратитесь к владельцу бота.", true);
  if (phase === "provider") return known("PROVIDER_FAILED", phase, reason, "Git provider сейчас недоступен. Повторите позже или проверьте подключение через /start.", true);
  if (phase === "codex") return known("CODEX_FAILED", phase, reason, "Codex не смог обработать запрос. Повторите позже или проверьте авторизацию через /start.", true);
  if (phase === "checkout") return known("CHECKOUT_FAILED", phase, reason, "Не удалось обновить локальную копию репозитория. Проверьте доступ и выбранную ветку, затем повторите.", true);
  if (phase === "callback") return known("CALLBACK_FAILED", phase, reason, "Не удалось выполнить действие. Повторите или вернитесь в меню; если ошибка сохранится, обратитесь к владельцу бота.", true);
  if (phase === "webhook") return known("WEBHOOK_PROCESSING_FAILED", phase, reason, "Не удалось обработать запрос Telegram. Повторите; если ошибка сохранится, обратитесь к владельцу бота.", true);
  return known("REQUEST_PROCESSING_FAILED", phase, reason, "Не удалось обработать запрос. Повторите позже; если ошибка сохранится, обратитесь к владельцу бота.", true);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const candidate = error as { description?: unknown; message?: unknown; code?: unknown; error_code?: unknown };
    const message = typeof candidate.description === "string" ? candidate.description : typeof candidate.message === "string" ? candidate.message : undefined;
    if (message) return message;
    if (candidate.error_code !== undefined || candidate.code !== undefined) return String(candidate.error_code ?? candidate.code);
  }
  return "UNKNOWN_ERROR";
}
