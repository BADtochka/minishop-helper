import { healthResponse, readyResponse } from "./health";
import type { AppDatabase } from "../storage/db";
import { handleTelegramWebhook } from "../telegram/webhook";
import type { TelegramBot } from "../telegram/bot";
import { createAuthRoutes, type AuthRoutesOptions } from "../auth/routes";

export function createRouter(database: AppDatabase, telegram: TelegramBot, auth?: AuthRoutesOptions, readiness?: () => Record<string, string>, requireRuntime = false) {
  const authRoutes = auth ? createAuthRoutes(auth) : undefined;
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") return healthResponse();
    if (request.method === "GET" && pathname === "/ready") return readyResponse(database, telegram.status, readiness?.(), requireRuntime);
    const authResponse = authRoutes && await authRoutes(request);
    if (authResponse) return authResponse;
    if (request.method === "POST" && pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, telegram.bot, telegram.webhookSecret, database, telegram.mode, auth?.logger);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
