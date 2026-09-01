import type { Config } from "../config";
import type { GitHubAppClient } from "../git/github/app-client";
import { createOAuthState, consumeOAuthState } from "./oauth-state";
import { createPkceChallenge } from "../storage/crypto";
import { GitCredentialRepository } from "../storage/git-credentials";
import type { AppDatabase } from "../storage/db";
import { consumeSetupSession, getSetupSession } from "./setup-session";
import { createSetupSession } from "./setup-session";
import { z } from "zod";
import type { Logger } from "../logger";
import { classifyError, safeErrorFields } from "../telegram/errors";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AuthConfig = Pick<Config, "OWNER_TELEGRAM_ID" | "PUBLIC_URL" | "APP_ENCRYPTION_KEY" | "GITLAB_BASE_URL" | "GITLAB_OAUTH_CLIENT_ID" | "GITLAB_OAUTH_CLIENT_SECRET" | "GITHUB_APP_SLUG"> & { GITLAB_REDIRECT_URI?: string };

export type AuthRoutesOptions = {
  database: AppDatabase;
  config: AuthConfig;
  fetch?: FetchFn;
  githubApp?: GitHubAppClient;
  notifyOwner?: (chatId: string, text: string, options?: Record<string, unknown>) => Promise<void>;
  editOwner?: (chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => Promise<void>;
  logger?: Logger;
};

export function createAuthRoutes(options: AuthRoutesOptions) {
const fetch = options.fetch ?? globalThis.fetch;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === "/setup" || url.pathname === "/setup/status" || url.pathname === "/setup/repositories" || url.pathname.startsWith("/setup/")) return Response.json({ error: "setup_moved_to_telegram" }, { status: 410 });
    if (request.method !== "GET" || !url.pathname.startsWith("/auth/")) return undefined;
    try {
      if (url.pathname === "/auth/gitlab/start") return await gitLabStart(options, url);
      if (url.pathname === "/auth/gitlab/callback") return await gitLabCallback(options, fetch, url);
      if (url.pathname === "/auth/github/start") return await githubStart(options, url);
      if (url.pathname === "/auth/github/callback") return await githubCallback(options, url);
      return undefined;
    } catch (error) {
      options.logger?.error("auth.request_failed", { ...safeErrorFields(error, "oauth"), provider: providerFromPath(url.pathname) });
      await notifySetupFailure(options, url, error);
      return Response.json({ error: "auth_failed", message: classifyError(error, "oauth").message }, { status: authFailureStatus(error) });
    }
  };
}

async function gitLabStart({ database, config }: AuthRoutesOptions, url: URL): Promise<Response> {
  const callback = callbackUrl(config, "gitlab");
  if (!config.GITLAB_OAUTH_CLIENT_ID || !config.GITLAB_OAUTH_CLIENT_SECRET || !config.APP_ENCRYPTION_KEY) throw new Error("GitLab OAuth is not configured");
  const session = await requireSetupSession(database, config, url);
  const { state, codeVerifier } = await createOAuthState(database, { provider: "gitlab", ownerTelegramId: session.ownerTelegramId, setupSessionId: session.id, originChatId: session.chatId, originMessageId: session.originMessageId, flow: session.flow });
  await consumeSetupSession(database, url.searchParams.get("token")!);
  const authorize = new URL("/oauth/authorize", config.GITLAB_BASE_URL);
  authorize.search = new URLSearchParams({ client_id: config.GITLAB_OAUTH_CLIENT_ID, redirect_uri: callback, response_type: "code", scope: "api", state, code_challenge: await createPkceChallenge(codeVerifier), code_challenge_method: "S256" }).toString();
  return Response.redirect(authorize, 302);
}

async function gitLabCallback(options: AuthRoutesOptions, fetch: FetchFn, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("GitLab callback is missing code or state");
  const callback = callbackUrl(options.config, "gitlab");
  if (!options.config.GITLAB_OAUTH_CLIENT_ID || !options.config.GITLAB_OAUTH_CLIENT_SECRET || !options.config.APP_ENCRYPTION_KEY) throw new Error("GitLab OAuth is not configured");
  const record = await consumeOAuthState(options.database, state);
  try {
    if (record.provider !== "gitlab" || !record.code_verifier) throw new Error("OAuth state does not match GitLab");
    if (!record.setup_session_id) throw new Error("OAuth state is not bound to an owner setup session");
    const tokenResponse = await fetchTimed(fetch, new URL("/oauth/token", options.config.GITLAB_BASE_URL), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: options.config.GITLAB_OAUTH_CLIENT_ID, client_secret: options.config.GITLAB_OAUTH_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: callback, code_verifier: record.code_verifier }) });
    if (!tokenResponse.ok) throw new Error("GitLab token exchange failed");
    const token = GitLabTokenSchema.parse(await tokenResponse.json());
    const userResponse = await fetchTimed(fetch, new URL("/api/v4/user", options.config.GITLAB_BASE_URL), { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } });
    if (!userResponse.ok) throw new Error("GitLab user lookup failed");
    const user = GitLabUserSchema.parse(await userResponse.json());
    const accountName = user.username ?? (user.id ? String(user.id) : undefined);
    if (!accountName) throw new Error("GitLab user lookup returned no account");
    await new GitCredentialRepository(options.database, options.config.APP_ENCRYPTION_KEY).saveGitLab(record.owner_telegram_id, accountName, { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: typeof token.expires_in === "number" ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined, baseUrl: options.config.GITLAB_BASE_URL });
    await notifyConnected(options, record, "GitLab");
    return success("GitLab подключён. Вернитесь в Telegram.");
  } catch (error) {
    await notifyOAuthFailure(options, record, error);
    throw error;
  }
}

async function githubStart({ database, config }: AuthRoutesOptions, url: URL): Promise<Response> {
  callbackUrl(config, "github");
  if (!config.GITHUB_APP_SLUG || !config.APP_ENCRYPTION_KEY) throw new Error("GitHub App is not configured");
  const session = await requireSetupSession(database, config, url);
  const { state } = await createOAuthState(database, { provider: "github", ownerTelegramId: session.ownerTelegramId, setupSessionId: session.id, originChatId: session.chatId, originMessageId: session.originMessageId, flow: session.flow, codeVerifier: "" });
  await consumeSetupSession(database, url.searchParams.get("token")!);
  const install = new URL(`/apps/${encodeURIComponent(config.GITHUB_APP_SLUG)}/installations/new`, "https://github.com");
  install.searchParams.set("state", state);
  return Response.redirect(install, 302);
}

async function githubCallback(options: AuthRoutesOptions, url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id");
  if (!state || !installationId || !/^\d+$/.test(installationId)) throw new Error("GitHub callback is missing state or installation_id");
  callbackUrl(options.config, "github");
  if (!options.config.GITHUB_APP_SLUG || !options.config.APP_ENCRYPTION_KEY) throw new Error("GitHub App is not configured");
  const record = await consumeOAuthState(options.database, state);
  try {
    if (record.provider !== "github" || !record.setup_session_id) throw new Error("OAuth state does not match an owner GitHub setup session");
    if (!options.githubApp) throw new Error("GitHub App authentication is not configured");
    const installation = await options.githubApp.getInstallation(installationId);
    await new GitCredentialRepository(options.database, options.config.APP_ENCRYPTION_KEY).saveGitHubInstallation(record.owner_telegram_id, installation.accountName, installationId);
    await notifyConnected(options, record, "GitHub");
    return success("GitHub подключён. Вернитесь в Telegram.");
  } catch (error) {
    await notifyOAuthFailure(options, record, error);
    throw error;
  }
}

function callbackUrl(config: AuthConfig, provider: "gitlab" | "github"): string {
  if (provider === "gitlab" && config.GITLAB_REDIRECT_URI) return config.GITLAB_REDIRECT_URI;
  if (!config.PUBLIC_URL) throw new Error("PUBLIC_URL is required for OAuth callbacks");
  return new URL(`/auth/${provider}/callback`, config.PUBLIC_URL).toString();
}

function success(message: string): Response {
  return new Response(message, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const GitLabTokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().nonnegative().optional() });
const GitLabUserSchema = z.object({ username: z.string().min(1).optional(), id: z.number().int().positive().optional() });

async function requireSetupSession(database: AppDatabase, config: AuthConfig, url: URL) {
  const token = url.searchParams.get("token");
  if (!token) throw new Error("A one-time owner setup token is required");
  const session = await getSetupSession(database, token);
  if (session.ownerTelegramId !== config.OWNER_TELEGRAM_ID) throw new Error("Setup token owner does not match configured owner");
  if (!session.flow.startsWith("oauth:") || session.chatId !== String(config.OWNER_TELEGRAM_ID)) throw new Error("OAuth must be started from the owner private Telegram conversation");
  return session;
}

async function fetchTimed(fetch: FetchFn, input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(input, { ...init, signal });
}

async function notifyConnected(options: AuthRoutesOptions, record: Awaited<ReturnType<typeof consumeOAuthState>>, provider: string): Promise<void> {
  if (!record.origin_chat_id || record.origin_chat_id !== String(record.owner_telegram_id)) return;
  const repositories = await createSetupSession(options.database, { chatId: record.origin_chat_id, ownerTelegramId: record.owner_telegram_id, flow: "repositories", originMessageId: record.origin_message_id });
  const menu = await createSetupSession(options.database, { chatId: record.origin_chat_id, ownerTelegramId: record.owner_telegram_id, flow: "menu", originMessageId: record.origin_message_id });
  const message = `${provider} подключён. Можно выбрать репозиторий.`;
  const markup = { reply_markup: { inline_keyboard: [
    [{ text: "Выбрать репозиторий", callback_data: `s:${repositories.action}` }],
    [{ text: "Главное меню", callback_data: `s:${menu.action}` }],
  ] } };
  if (record.origin_message_id && options.editOwner) {
    try { await options.editOwner(record.origin_chat_id, record.origin_message_id, message, markup); return; } catch { /* Fall back to a new message when the origin was deleted. */ }
  }
  try { await options.notifyOwner?.(record.origin_chat_id, message, markup); } catch (error) {
    options.logger?.error("auth.telegram_notification_failed", safeErrorFields(error, "telegram_feedback", { chatId: record.origin_chat_id }));
  }
}

type OAuthRecord = Awaited<ReturnType<typeof consumeOAuthState>>;

async function notifyOAuthFailure(options: AuthRoutesOptions, record: OAuthRecord, error: unknown): Promise<void> {
  if (!record.origin_chat_id || record.origin_chat_id !== String(record.owner_telegram_id)) return;
  await deliverAuthFailure(options, record.origin_chat_id, record.origin_message_id ?? undefined, classifyError(error, "oauth").message);
}

async function notifySetupFailure(options: AuthRoutesOptions, url: URL, error: unknown): Promise<void> {
  const token = url.searchParams.get("token");
  if (!token) return;
  try {
    const session = await getSetupSession(options.database, token);
    if (session.ownerTelegramId !== options.config.OWNER_TELEGRAM_ID || session.chatId !== String(session.ownerTelegramId)) return;
    await deliverAuthFailure(options, session.chatId, session.originMessageId ?? undefined, classifyError(error, "oauth").message);
  } catch { /* Invalid or consumed setup tokens have no trustworthy Telegram destination. */ }
}

async function deliverAuthFailure(options: AuthRoutesOptions, chatId: string, messageId: number | undefined, text: string): Promise<void> {
  if (messageId && options.editOwner) {
    try { await options.editOwner(chatId, messageId, text); return; } catch { /* Fall back to a new message. */ }
  }
  try { await options.notifyOwner?.(chatId, text); } catch (error) {
    options.logger?.error("auth.telegram_notification_failed", safeErrorFields(error, "telegram_feedback", { chatId }));
  }
}

function providerFromPath(path: string): string {
  return path.includes("gitlab") ? "gitlab" : path.includes("github") ? "github" : "unknown";
}

function authFailureStatus(error: unknown): number {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.includes("not configured") || text.includes("public_url is required")) return 503;
  if (text.includes("failed") || text.includes("timeout")) return 502;
  return 400;
}
