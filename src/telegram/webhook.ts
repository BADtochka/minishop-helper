import type { Bot } from "grammy";
import type { AppDatabase } from "../storage/db";
import type { Logger } from "../logger";
import { safeErrorFields } from "./errors";

export function isWebhookSecretValid(provided: string | null, expected: string | undefined): boolean {
  return expected !== undefined && provided === expected;
}

export async function handleTelegramWebhook(
  request: Request,
  bot: Bot | undefined,
  webhookSecret: string | undefined,
  database?: AppDatabase,
  mode: "webhook" | "polling" = "webhook",
  logger?: Logger,
): Promise<Response> {
  if (mode === "polling") return Response.json({ error: "polling_enabled" }, { status: 409 });
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!isWebhookSecretValid(secret, webhookSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!bot) return Response.json({ error: "telegram_not_configured" }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return Response.json({ error: "payload_too_large" }, { status: 413 });

  try {
    const text = await request.text();
    if (text.length > 1_000_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const update = JSON.parse(text) as Parameters<Bot["handleUpdate"]>[0];
    await bot.handleUpdate(update);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger?.error("telegram.webhook_rejected", safeErrorFields(error, "webhook"));
      return Response.json({ error: "invalid_update" }, { status: 400 });
    }
    logger?.error("telegram.webhook_failed", safeErrorFields(error, "webhook"));
    return Response.json({ error: "update_processing_failed" }, { status: 500 });
  }
}
