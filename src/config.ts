import { z } from "zod";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalPositiveInt = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().positive().optional());
const envBoolean = z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.enum(["true", "false"]).default("false")).transform((value) => value === "true");

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("webhook"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(1337),
  DATABASE_PATH: z.string().min(1).default("/data/bot.sqlite"),
  CONTEXT_MODE: z.enum(["project_context", "repository"]).default("project_context"),
  REPOSITORIES_PATH: z.string().min(1).default("/data/repositories"),
  REPOSITORY_REFRESH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  CODEX_HOME: z.string().min(1).default("/data/codex"),
  CODEX_WORKSPACE: z.string().min(1).default("/data/codex-workspace"),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  CODEX_MODEL: optionalString,
  CODEX_EFFORT: optionalString,
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  OWNER_TELEGRAM_ID: z.coerce.number().int().safe().positive(),
  TELEGRAM_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_SECRET: optionalString,
  TELEGRAM_DROP_PENDING_UPDATES: envBoolean,
  // Encryption is not needed until a provider connection is created.
  APP_ENCRYPTION_KEY: optionalString,
  PUBLIC_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_REDIRECT_URI: optionalString,
  GITLAB_OAUTH_CLIENT_ID: optionalString,
  GITLAB_OAUTH_CLIENT_SECRET: optionalString,
  GITHUB_APP_SLUG: optionalString,
  GITHUB_APP_ID: optionalPositiveInt,
  // PEM may be supplied with literal newlines or escaped \n from a secret store.
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_PRIVATE_KEY_FILE: optionalString,
}).superRefine((config, context) => {
  const issue = (path: keyof typeof config, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (config.NODE_ENV === "production" && config.PUBLIC_URL && new URL(config.PUBLIC_URL).protocol !== "https:") issue("PUBLIC_URL", "Production PUBLIC_URL must use HTTPS");
  const gitlab = new URL(config.GITLAB_BASE_URL);
  if (gitlab.username || gitlab.password || gitlab.search || gitlab.hash || gitlab.pathname !== "/") issue("GITLAB_BASE_URL", "GitLab URL must be an origin without credentials, path, query, or fragment");
  if (config.NODE_ENV === "production" && gitlab.protocol !== "https:") issue("GITLAB_BASE_URL", "Production GitLab URL must use HTTPS");
  if (Boolean(config.GITLAB_OAUTH_CLIENT_ID) !== Boolean(config.GITLAB_OAUTH_CLIENT_SECRET)) issue("GITLAB_OAUTH_CLIENT_SECRET", "GitLab OAuth client ID and secret must be configured together");
  if (config.GITLAB_REDIRECT_URI) {
    try {
      const redirect = new URL(config.GITLAB_REDIRECT_URI);
      if (!redirect.pathname.endsWith("/auth/gitlab/callback") || redirect.search || redirect.hash) issue("GITLAB_REDIRECT_URI", "GitLab redirect URI must end with /auth/gitlab/callback and have no query or fragment");
      if (config.NODE_ENV === "production" && redirect.protocol !== "https:") issue("GITLAB_REDIRECT_URI", "Production GitLab redirect URI must use HTTPS");
    } catch {
      issue("GITLAB_REDIRECT_URI", "GitLab redirect URI must be a valid URL");
    }
  }
  if (config.GITHUB_APP_PRIVATE_KEY && config.GITHUB_APP_PRIVATE_KEY_FILE) issue("GITHUB_APP_PRIVATE_KEY_FILE", "Configure either GitHub App PEM or PEM file, not both");
  const githubValues = [config.GITHUB_APP_SLUG, config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY || config.GITHUB_APP_PRIVATE_KEY_FILE].filter(Boolean).length;
  if (githubValues > 0 && githubValues < 3) issue("GITHUB_APP_PRIVATE_KEY", "GitHub App slug, ID, and private key must be configured together");
  if ((githubValues || config.GITLAB_OAUTH_CLIENT_ID) && !config.APP_ENCRYPTION_KEY) issue("APP_ENCRYPTION_KEY", "Provider configuration requires APP_ENCRYPTION_KEY");
  if (config.NODE_ENV === "production" && config.TELEGRAM_MODE === "polling") issue("TELEGRAM_MODE", "Telegram polling is not supported in production; use webhook mode");
  if (config.TELEGRAM_TOKEN && config.TELEGRAM_MODE === "webhook") {
    if (!config.PUBLIC_URL) issue("PUBLIC_URL", "Telegram webhook mode requires PUBLIC_URL");
    if (!config.TELEGRAM_WEBHOOK_SECRET) issue("TELEGRAM_WEBHOOK_SECRET", "Telegram webhook mode requires TELEGRAM_WEBHOOK_SECRET");
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return configSchema.parse(env);
}
