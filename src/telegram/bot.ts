import { Bot } from "grammy";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { registerCommands } from "./commands";
import { handleTelegramRequest, type TelegramRequestHandlerOptions } from "./request-handler";
import type { CodexAuthService } from "../codex/auth";
import type { CodexLoginCompletionNotifier } from "../codex/auth";
import { handlePreviewCallback } from "./preview-handler";
import type { IssueJobData } from "../jobs/process-issue";
import type { GitProvider } from "../git/provider";
import type { RepositorySetupService } from "../git/setup-service";
import type { AppDatabase } from "../storage/db";
import { consumeSetupSessionById, createSetupSession, latestSetupSession } from "../auth/setup-session";
import { ChatRegistry } from "./chat-registry";
import type { ProgressReporter } from "../progress";
import { notifyTelegramError, safeErrorFields } from "./errors";

export const CODEX_LOGIN_COMPLETED_MESSAGE = "Codex: авторизация успешно завершена.";

export function createCodexLoginCompletionNotifier(bot: Pick<Bot, "api">, ownerTelegramId: number, database?: AppDatabase, logger?: Logger): CodexLoginCompletionNotifier {
  return async () => {
    const origin = database ? latestSetupSession(database, ownerTelegramId, "codex:login") : null;
    const action = database ? await createSetupSession(database, { chatId: String(ownerTelegramId), ownerTelegramId, flow: "codex:status", originMessageId: origin?.originMessageId }) : undefined;
    const options = action ? { reply_markup: { inline_keyboard: [[{ text: "Проверить статус", callback_data: `s:${action.action}` }]] } } : undefined;
    if (origin?.originMessageId) {
      try {
        await bot.api.editMessageText(ownerTelegramId, origin.originMessageId, CODEX_LOGIN_COMPLETED_MESSAGE, options);
        consumeSetupSessionById(database!, origin.id);
        return;
      } catch (error) {
        logger?.info("telegram.codex_notification_recovery", safeErrorFields(error, "telegram_feedback", { chatId: ownerTelegramId }));
      }
    }
    try {
      await bot.api.sendMessage(ownerTelegramId, CODEX_LOGIN_COMPLETED_MESSAGE, options);
    } catch (error) {
      logger?.error("telegram.codex_notification_failed", safeErrorFields(error, "telegram_feedback", { chatId: ownerTelegramId }));
      throw error;
    }
  };
}

export type TelegramBot = {
  bot?: Bot;
  username?: string;
  webhookSecret?: string;
  mode: "webhook" | "polling";
  activate: () => Promise<void>;
  stop: () => Promise<void>;
  status: "starting" | "ready" | "failed" | "not_configured";
  pollingPromise?: Promise<void>;
};

type BootTelegramOptions = {
  createBot?: (token: string) => Bot;
};

export async function bootTelegram(config: Config, logger: Logger, requestHandler?: Omit<TelegramRequestHandlerOptions, "botUsername" | "ownerTelegramId"> & { codex?: CodexAuthService; getIntegrationStatus?: () => { git: string; provider: string; repository: string; worker: string }; contextRefresh?: (chatId: string, progress?: ProgressReporter) => Promise<string>; repositoryRefresh?: (chatId: string, progress?: ProgressReporter) => Promise<string>; repositorySetup?: RepositorySetupService; previewProviderForRepository?: (job: IssueJobData) => Promise<Pick<GitProvider, "createIssue" | "findIssueByMarker">> }, options: BootTelegramOptions = {}): Promise<TelegramBot> {
  if (!config.TELEGRAM_TOKEN) {
    logger.info("telegram.not_configured");
    return { mode: config.TELEGRAM_MODE, activate: async () => undefined, stop: async () => undefined, status: "not_configured" };
  }

  const bot = options.createBot?.(config.TELEGRAM_TOKEN) ?? new Bot(config.TELEGRAM_TOKEN);
  const me = await bot.api.getMe();
  bot.botInfo = me;
  const username = me.username;

  let telegram!: TelegramBot;
  bot.use(async (context, next) => {
    logger.info("telegram.update_received", { update_id: context.update.update_id });
    try {
      await next();
    } catch (error) {
      await notifyTelegramError(context, error, { phase: "update", logger, event: "telegram.update_failed", answerCallback: Boolean(context.callbackQuery) });
    }
  });
  if (requestHandler?.database) {
    const registry = new ChatRegistry(requestHandler.database);
    bot.use(async (context, next) => {
      await registry.observe(context, config.OWNER_TELEGRAM_ID, me.id);
      await next();
    });
  }
  try {
    await registerCommands(bot, {
      ownerTelegramId: config.OWNER_TELEGRAM_ID,
      botTelegramId: me.id,
      getStatus: () => telegram?.status ?? "starting",
      getUsername: () => username,
      codex: requestHandler?.codex,
      getIntegrationStatus: requestHandler?.getIntegrationStatus,
      database: requestHandler?.database,
      publicUrl: config.PUBLIC_URL,
       logger,
        contextRefresh: requestHandler?.contextRefresh,
         repositoryRefresh: requestHandler?.repositoryRefresh,
         getContextMode: () => config.CONTEXT_MODE,
         repositorySetup: requestHandler?.repositorySetup,
    });
  } catch (error) {
     logger.error("telegram.commands_registration_failed", safeErrorFields(error, "update"));
    throw error;
  }
  bot.on(["message", "guest_message"], async (context) => {
    if (!username || !requestHandler) return;
    await handleTelegramRequest(context, {
      ...requestHandler,
      botUsername: username,
      ownerTelegramId: config.OWNER_TELEGRAM_ID,
      logger,
      downloadTelegramImage: (fileId) => downloadTelegramImage(bot, config.TELEGRAM_TOKEN!, fileId),
    });
  });
  bot.on("callback_query:data", async (context) => {
    if (!requestHandler?.previewProviderForRepository) return;
    await handlePreviewCallback(context, { database: requestHandler.database, ownerTelegramId: config.OWNER_TELEGRAM_ID, providerForRepository: requestHandler.previewProviderForRepository, logger });
  });
  bot.catch(async (error) => {
    await notifyTelegramError(error.ctx, error.error, { phase: "update", logger, event: "telegram.update_failed", answerCallback: Boolean(error.ctx.callbackQuery) });
  });

  let activated = false;
  let stopPromise: Promise<void> | undefined;
  telegram = {
    bot,
    username,
    webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
    mode: config.TELEGRAM_MODE,
    activate: async () => {
      if (activated) return;
      activated = true;
      if (config.TELEGRAM_MODE === "webhook") {
        await bot.api.setWebhook(new URL("/telegram/webhook", config.PUBLIC_URL!).toString(), { secret_token: config.TELEGRAM_WEBHOOK_SECRET });
        telegram.status = "ready";
        logger.info("telegram.webhook_started", { username });
        return;
      }
      await bot.api.deleteWebhook({ drop_pending_updates: config.TELEGRAM_DROP_PENDING_UPDATES });
      const pollingPromise = bot.start({
        onStart: () => {
          telegram.status = "ready";
          logger.info("telegram.polling_started", { username });
        },
      });
      telegram.pollingPromise = pollingPromise;
      void pollingPromise.catch((error) => {
        telegram.status = "failed";
        logger.error("telegram.polling_failed", safeErrorFields(error, "update"));
      });
    },
    stop: async () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        let stopError: unknown;
        if (config.TELEGRAM_MODE === "polling" && telegram.pollingPromise) {
          try {
            await bot.stop();
          } catch (error) {
            stopError = error;
          } finally {
            await telegram.pollingPromise.catch(() => undefined);
          }
        }
        if (stopError) throw stopError;
      })();
      return stopPromise;
    },
    status: "starting",
  };
  return telegram;
}

async function downloadTelegramImage(bot: Bot, token: string, fileId: string): Promise<{ mimeType: string; dataBase64: string; filename: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram image has no file path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || !response.body || (Number.isFinite(length) && length > 10 * 1024 * 1024)) throw new Error("Telegram image download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Telegram image is too large");
  const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0];
  const mimeType = responseMimeType?.startsWith("image/") ? responseMimeType : imageMimeTypeFromPath(file.file_path);
  if (!mimeType.startsWith("image/")) throw new Error("Telegram attachment is not an image");
  return { mimeType, dataBase64: Buffer.from(bytes).toString("base64"), filename: `telegram-image.${imageExtension(mimeType)}` };
}

function imageExtension(mimeType: string): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
}

function imageMimeTypeFromPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "application/octet-stream";
}
