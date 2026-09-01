import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createRouter } from "./server/router";
import { openDatabase } from "./storage/db";
import { migrate } from "./storage/migrations";
import { bootTelegram, createCodexLoginCompletionNotifier } from "./telegram/bot";
import { JobQueue } from "./jobs/queue";
import { IssueWorker } from "./jobs/worker";
import { CodexProcessManager } from "./codex/process";
import { CodexAuthService, type CodexLoginCompletionNotifier } from "./codex/auth";
import { GitCredentialRepository } from "./storage/git-credentials";
import { GitLabClient } from "./git/gitlab/client";
import { GitLabProvider } from "./git/gitlab/provider";
import { GitHubProvider } from "./git/github/provider";
import { GitHubClient } from "./git/github/client";
import { GitHubAppApiClient } from "./git/github/app-client";
import type { GitProvider } from "./git/provider";
import type { GitRepository } from "./git/types";
import { RepositoryBindingRepository } from "./storage/repository-bindings";
import { RepositorySetupService } from "./git/setup-service";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { ProjectContextService } from "./context/service";
import { ProjectContextStorage } from "./context/storage";
import { collectProjectSources } from "./context/source-collector";
import { RepositoryCheckoutManager } from "./repositories/checkout";
import { parseEncryptionKey } from "./storage/crypto";
import { editRichMessage, sendRichMessage } from "./telegram/rich-message";
import { cleanupLegacyPreviewImages } from "./telegram/preview-images";

const config = loadConfig();
// Fail at startup for an invalid key instead of misclassifying it as a provider failure.
if (config.APP_ENCRYPTION_KEY) parseEncryptionKey(config.APP_ENCRYPTION_KEY);
const logger = createLogger();
const database = openDatabase(config.DATABASE_PATH);
migrate(database);
const queue = new JobQueue(database);
let worker: IssueWorker | undefined;
const codexRuntimeAvailable = Bun.which(config.CODEX_BIN) !== null;
const codex = new CodexProcessManager({ bin: config.CODEX_BIN, home: config.CODEX_HOME, workspace: config.CODEX_WORKSPACE, requestTimeoutMs: config.CODEX_REQUEST_TIMEOUT_MS });
let notifyCodexLoginCompleted: CodexLoginCompletionNotifier | undefined;
const codexAuth = new CodexAuthService(
  () => codex.start(),
  ({ phase, errorCode }) => logger.error("codex.diagnostic", { phase, error_code: errorCode }),
  async () => {
    if (!notifyCodexLoginCompleted) throw new Error("Telegram notifier is unavailable");
    await notifyCodexLoginCompleted();
  },
);
const workerOptions: ConstructorParameters<typeof IssueWorker>[2] = { pollIntervalMs: config.JOB_POLL_INTERVAL_MS, logger };
const credentials = config.APP_ENCRYPTION_KEY ? new GitCredentialRepository(database, config.APP_ENCRYPTION_KEY) : undefined;
const githubPrivateKey = config.GITHUB_APP_PRIVATE_KEY ?? (config.GITHUB_APP_PRIVATE_KEY_FILE ? readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, "utf8") : undefined);
const githubApp = config.GITHUB_APP_ID && githubPrivateKey
  ? new GitHubAppApiClient(config.GITHUB_APP_ID, githubPrivateKey)
  : undefined;
const resolveProvider = async (ownerTelegramId: number, provider: string): Promise<GitProvider | undefined> => {
  if (!credentials) return undefined;
  if (provider === "github") {
    const installation = await credentials.getGitHubInstallation(ownerTelegramId);
    return installation && githubApp ? new GitHubProvider(new GitHubClient({ token: () => githubApp.createInstallationToken(installation.installationId) })) : undefined;
  }
  if (provider !== "gitlab") return undefined;
  const gitlab = await credentials.getGitLab(ownerTelegramId);
  if (!gitlab) return undefined;
  return new GitLabProvider(new GitLabClient({
    baseUrl: gitlab.baseUrl,
    token: async () => (await credentials.getGitLab(ownerTelegramId))?.accessToken ?? gitlab.accessToken,
    refreshToken: () => refreshGitLabToken(credentials, ownerTelegramId, gitlab.baseUrl),
  }));
};
const projectContexts = new ProjectContextService(new ProjectContextStorage(database), {
  generateProjectContext: (sources) => codexAuth.generateProjectContext({ sources, model: config.CODEX_MODEL, effort: config.CODEX_EFFORT }),
});
const checkouts = new RepositoryCheckoutManager({ repositoriesPath: config.REPOSITORIES_PATH, timeoutMs: config.REPOSITORY_REFRESH_TIMEOUT_MS });
const repositorySetup = credentials ? new RepositorySetupService(new RepositoryBindingRepository(database), resolveProvider, async (stored, repository, provider) => {
  const sources = await collectProjectSources(provider, repository);
  await projectContexts.refresh(stored.id, sources);
}) : undefined;

if (config.TELEGRAM_TOKEN && credentials) {
    worker = new IssueWorker(queue, {
      codex: {
        generateIssue: (input) => codexAuth.generateIssue({ ...input, model: config.CODEX_MODEL, effort: config.CODEX_EFFORT }),
        generateIssueWithUsage: (input) => codexAuth.generateIssueWithUsage({ ...input, model: config.CODEX_MODEL, effort: config.CODEX_EFFORT }),
      },
      provider: {
        listLabels: async () => { throw new Error("Repository provider is not configured"); },
        createIssue: async () => { throw new Error("Repository provider is not configured"); },
      },
      providerForRepository: (_repository: GitRepository, repositoryId: string) => resolveProvider(config.OWNER_TELEGRAM_ID, providerForRepository(repositoryId))
        .then((provider) => {
          if (!provider) throw new Error("Repository provider is not configured");
          return provider;
        }),
      ...(config.CONTEXT_MODE === "repository" ? {
        repositoryCheckout: async (job) => {
          const stored = new RepositoryBindingRepository(database).getRepository(job.repositoryId);
          if (!stored) throw new Error("Привязанный репозиторий больше не найден.");
          const provider = await resolveProvider(config.OWNER_TELEGRAM_ID, stored.provider);
          if (!provider) throw new Error("Git provider для репозитория недоступен.");
          const repository = withBranch(await provider.getRepository(toGitRepository(stored)), stored.branch);
          return checkouts.refresh({ connectionId: stored.gitConnectionId, repositoryId: stored.id, repository, provider });
        },
      } : {}),
    }, workerOptions);
}

const telegram = await bootTelegram(config, logger, {
  database,
  queue,
  integrationsAvailable: () => integrationsAvailable(database, codexRuntimeAvailable),
  codex: codexAuth,
  getIntegrationStatus: () => integrationStatus(database, Boolean(worker)),
  contextRefresh: async (chatId, progress) => {
    const stored = new RepositoryBindingRepository(database).resolveActive(chatId);
    if (!stored) return "Для этого чата нет активного репозитория.";
    const provider = await resolveProvider(config.OWNER_TELEGRAM_ID, stored.provider);
    if (!provider) return "Git provider для репозитория недоступен.";
    const repository = withBranch(await provider.getRepository(toGitRepository(stored)), stored.branch);
    const sources = await collectProjectSources(provider, repository, { progress });
    await projectContexts.refresh(stored.id, sources, true, progress);
    return `Контекст проекта ${stored.fullName} собран и обновлён.`;
  },
  repositoryRefresh: async (chatId, progress) => {
    if (config.CONTEXT_MODE !== "repository") return "Режим repository выключен. Установите CONTEXT_MODE=repository и перезапустите сервис.";
    const stored = new RepositoryBindingRepository(database).resolveActive(chatId);
    if (!stored) return "Для этого чата нет активного репозитория.";
    const provider = await resolveProvider(config.OWNER_TELEGRAM_ID, stored.provider);
    if (!provider) return "Git provider для репозитория недоступен.";
    const repository = withBranch(await provider.getRepository(toGitRepository(stored)), stored.branch);
    const checkout = await checkouts.refresh({ connectionId: stored.gitConnectionId, repositoryId: stored.id, repository, provider, progress });
    return `Локальная копия ${stored.fullName} обновлена: ветка ${checkout.branch}.`;
  },
  repositorySetup,
  previewProviderForRepository: (job) => resolveProvider(config.OWNER_TELEGRAM_ID, providerForRepository(job.repositoryId)).then((provider) => {
    if (!provider) throw new Error("Repository provider is not configured");
    return provider;
  }),
});
if (telegram.bot) notifyCodexLoginCompleted = createCodexLoginCompletionNotifier(telegram.bot, config.OWNER_TELEGRAM_ID, database, logger);
if (worker && telegram.bot) {
  workerOptions.telegram = {
    sendMessage: (chatId, text) => telegram.bot!.api.sendMessage(chatId, text),
    editMessageText: (chatId, messageId, text, threadId, replyTo) => telegram.bot!.api.editMessageText(chatId, messageId, text, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }),
    } as never),
    sendProgress: (chatId, text, threadId, replyTo) => telegram.bot!.api.sendMessage(chatId, text, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }),
    }),
    sendPreview: (chatId, text, requestId, threadId, replyTo) => {
      return sendRichMessage(telegram.bot!.api, chatId, text, {
        ...Object.fromEntries(Object.entries({ ...(threadId === undefined ? {} : { message_thread_id: threadId }), ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }) })),
        reply_markup: { inline_keyboard: [[
          { text: "Подтвердить", callback_data: `confirm:${requestId}` },
          { text: "Отклонить", callback_data: `reject:${requestId}` },
          { text: "Уточнить", callback_data: `clarify:${requestId}` },
        ]] },
      });
    },
    sendPreviewRecovery: (chatId, text, requestId, threadId, replyTo) => telegram.bot!.api.sendMessage(chatId, text, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }),
      reply_markup: { inline_keyboard: [[{ text: "Создать новый предпросмотр", callback_data: `recreate_preview:${requestId}` }]] },
    }),
    editPreview: (chatId, messageId, text, images, requestId, threadId, replyTo) => editRichMessage(telegram.bot!.api, chatId, messageId, text, {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }),
      reply_markup: { inline_keyboard: [[
        { text: "Подтвердить", callback_data: `confirm:${requestId}` },
        { text: "Отклонить", callback_data: `reject:${requestId}` },
        { text: "Уточнить", callback_data: `clarify:${requestId}` },
      ]] },
    }, images),
    cleanupLegacyPreviewImages: (chatId, messageIds) => cleanupLegacyPreviewImages(telegram.bot!.api, chatId, messageIds),
    deleteMessage: (chatId, messageId) => telegram.bot!.api.deleteMessage(chatId, messageId),
  };
  worker.start();
}

const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  fetch: createRouter(database, telegram, { database, config, githubApp, logger, notifyOwner: async (chatId, text, options) => { await telegram.bot?.api.sendMessage(chatId, text, options); }, editOwner: async (chatId, messageId, text, options) => { await telegram.bot?.api.editMessageText(chatId, messageId, text, options); } }, () => ({
    codex: codexRuntimeAvailable ? "ready" : "unavailable",
    ...integrationStatus(database, Boolean(worker)),
  }), config.NODE_ENV === "production"),
});

logger.info("server.started", { hostname: config.HOST, port: server.port });

let shuttingDown = false;
await telegram.activate().catch(async (error) => {
  logger.error("telegram.activation_failed", { error: error instanceof Error ? error.message : String(error) });
  await shutdown("telegram_activation_failed");
  throw error;
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.stopping", { signal });
  server.stop(true);
  try {
    await bounded(telegram.stop(), 10_000, "Telegram shutdown timed out");
  } catch (error) {
    logger.error("telegram.shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    try {
      await bounded(worker?.stop() ?? Promise.resolve(), 15_000, "Worker shutdown timed out");
    } catch (error) {
      logger.error("worker.shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        await bounded(codex.stop(), 10_000, "Codex shutdown timed out");
      } catch (error) {
        logger.error("codex.shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        database.close();
        logger.info("server.stopped");
      }
    }
  }
}

function providerForRepository(repositoryId: string): "github" | "gitlab" {
  const row = database.query<{ provider: string }, [string]>(`
    SELECT git_connections.provider FROM repositories
    JOIN git_connections ON git_connections.id = repositories.git_connection_id
    WHERE repositories.id = ? LIMIT 1
  `).get(repositoryId);
  if (row?.provider === "github" || row?.provider === "gitlab") return row.provider;
  throw new Error("Repository provider is not configured");
}

async function refreshGitLabToken(credentials: GitCredentialRepository, ownerTelegramId: number, baseUrl: string): Promise<string> {
  if (!config.GITLAB_OAUTH_CLIENT_ID || !config.GITLAB_OAUTH_CLIENT_SECRET) throw new Error("GitLab OAuth refresh is not configured");
  const updated = await credentials.refreshGitLab(ownerTelegramId, async (refreshToken) => {
    const response = await fetch(new URL("/oauth/token", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: config.GITLAB_OAUTH_CLIENT_ID!, client_secret: config.GITLAB_OAUTH_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("GitLab token refresh failed");
    const token = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().nonnegative().optional() }).parse(await response.json());
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: typeof token.expires_in === "number" ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined };
  });
  return updated.accessToken;
}

function integrationsAvailable(database: ReturnType<typeof openDatabase>, codexAvailable: boolean): boolean {
  return codexAvailable
    && Boolean(database.query("SELECT 1 FROM git_connections WHERE credentials_encrypted IS NOT NULL LIMIT 1").get())
    && Boolean(database.query("SELECT 1 FROM chat_bindings LIMIT 1").get());
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function integrationStatus(database: ReturnType<typeof openDatabase>, workerActive: boolean): { git: string; provider: string; repository: string; worker: string } {
  const gitConnected = Boolean(database.query("SELECT 1 FROM git_connections WHERE credentials_encrypted IS NOT NULL LIMIT 1").get());
  const repositoryBound = Boolean(database.query("SELECT 1 FROM chat_bindings LIMIT 1").get());
  return {
    git: gitConnected ? "connected" : "not configured",
    provider: gitConnected ? "connected" : "not configured",
    repository: repositoryBound ? "configured" : "not configured",
    worker: workerActive ? "running" : "not configured",
  };
}

function toGitRepository(row: { providerRepositoryId: string; fullName: string; webUrl: string | null; defaultBranch: string | null }): GitRepository {
  const separator = row.fullName.lastIndexOf("/");
  return { id: row.providerRepositoryId, owner: separator < 0 ? "" : row.fullName.slice(0, separator), name: separator < 0 ? row.fullName : row.fullName.slice(separator + 1), fullName: row.fullName, description: null, private: false, webUrl: row.webUrl ?? "", defaultBranch: row.defaultBranch };
}

function withBranch(repository: GitRepository, branch: string | null): GitRepository {
  return { ...repository, defaultBranch: branch ?? repository.defaultBranch };
}
