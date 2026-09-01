import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Env = Record<string, string>;
export type ProviderSelection = "github" | "gitlab" | "both" | "skip";
export type ContextMode = "project_context" | "repository";

export interface SetupIO {
  ask(prompt: string, options?: { secret?: boolean }): Promise<string>;
  select?: (prompt: string, choices: string[], current?: string) => Promise<string>;
  write(message: string): void;
}

export interface SetupOptions {
  cwd?: string;
  envPath?: string;
  random?: (size: number) => Uint8Array;
}

export function generateWebhookSecret(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString("base64url");
}

export function generateEncryptionKey(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString("base64");
}

export function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isProviderSelection(value: string): value is ProviderSelection {
  return value === "github" || value === "gitlab" || value === "both" || value === "skip";
}

export function isContextMode(value: string): value is ContextMode { return value === "project_context" || value === "repository"; }

export function parseDotenv(source: string): Env {
  const result: Env = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      result[key] = raw.slice(1, -1).replace(/\\n/g, "\n");
    } else result[key] = raw.replace(/\s+#.*$/, "");
  }
  return result;
}

function escapeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(value) ? value : JSON.stringify(value).replace(/\n/g, "\\n");
}

export function serializeDotenv(existing: string, values: Env): string {
  const remaining = new Map(Object.entries(values));
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const updated = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/);
    if (!match || !remaining.has(match[2])) return line;
    const value = remaining.get(match[2])!;
    remaining.delete(match[2]);
    return `${match[1]}${match[2]}${match[3]}${escapeEnvValue(value)}`;
  });
  for (const [key, value] of remaining) updated.push(`${key}=${escapeEnvValue(value)}`);
  return `${updated.join("\n").replace(/\n+$/, "")}\n`;
}

export async function readSetupEnv(envPath: string): Promise<{ source: string; env: Env }> {
  try {
    const source = await readFile(envPath, "utf8");
    return { source, env: parseDotenv(source) };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const examplePath = join(dirname(envPath), ".env.example");
    try {
      const source = await readFile(examplePath, "utf8");
      return { source, env: parseDotenv(source) };
    } catch (exampleError) {
      if (exampleError instanceof Error && "code" in exampleError && exampleError.code === "ENOENT") return { source: "", env: {} };
      throw exampleError;
    }
  }
}

export async function writeEnvAtomically(envPath: string, source: string): Promise<void> {
  const temporaryPath = `${envPath}.setup-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, source, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, envPath);
  await chmod(envPath, 0o600);
}

async function answer(io: SetupIO, prompt: string, current = ""): Promise<string> {
  const suffix = current ? ` [${current}]` : "";
  const value = (await io.ask(`${prompt}${suffix}: `)).trim();
  return value || current;
}

async function choose(io: SetupIO, prompt: string, choices: string[], current: string): Promise<string> {
  for (;;) {
    const selected = ((io.select ? await io.select(prompt, choices, current) : await answer(io, `${prompt} (${choices.join(" / ")})`, current)).trim() || current);
    if (choices.includes(selected)) return selected;
    io.write(`Выберите один из вариантов: ${choices.join(", ")}.`);
  }
}

async function required(io: SetupIO, prompt: string, current: string, valid: (value: string) => boolean, hint: string, secret = false): Promise<string> {
  for (;;) {
    const value = (await io.ask(`${prompt}${current ? " [Enter = оставить текущее]" : ""}: `, { secret })).trim();
    if (!value && current) return current;
    if (valid(value)) return value;
    io.write(hint);
  }
}

async function generatedSecret(io: SetupIO, env: Env, key: string, make: () => string): Promise<void> {
  if (env[key]) {
    const replace = (await io.ask(`${key} уже задан. Сгенерировать новый? [y/N]: `)).trim().toLowerCase();
    if (replace !== "y" && replace !== "yes" && replace !== "д") return;
    const confirm = (await io.ask("Это заменит существующий секрет. Продолжить? [y/N]: ")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes" && confirm !== "д") return;
  }
  env[key] = make();
  io.write(`${key} сгенерирован и будет сохранен; значение не выводится.`);
}

async function optionalSecret(io: SetupIO, env: Env, key: string, prompt: string): Promise<void> {
  const value = (await io.ask(`${prompt}${env[key] ? " [Enter = оставить текущее]" : " [Enter = пропустить]"}: `, { secret: true })).trim();
  if (!value) return;
  if (env[key]) {
    const confirm = (await io.ask(`${key} уже задан. Заменить? [y/N]: `)).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes" && confirm !== "д") return;
  }
  env[key] = value;
}

async function configureGitHub(io: SetupIO, env: Env): Promise<void> {
  io.write("GitHub App необязателен: настройку можно завершить позже.");
  const slug = await answer(io, "GitHub App slug (Enter = пропустить)", env.GITHUB_APP_SLUG);
  if (!slug) return;
  const id = await required(io, "GitHub App ID", env.GITHUB_APP_ID ?? "", isPositiveInteger, "Введите положительный числовой ID.");
  const file = await answer(io, "Путь к PEM-файлу (Enter = ввести PEM)", env.GITHUB_APP_PRIVATE_KEY_FILE ?? "");
  env.GITHUB_APP_SLUG = slug;
  env.GITHUB_APP_ID = id;
  if (file) {
    env.GITHUB_APP_PRIVATE_KEY_FILE = file;
    delete env.GITHUB_APP_PRIVATE_KEY;
  } else {
    await optionalSecret(io, env, "GITHUB_APP_PRIVATE_KEY", "GitHub App private key PEM");
    if (!env.GITHUB_APP_PRIVATE_KEY) {
      delete env.GITHUB_APP_SLUG;
      delete env.GITHUB_APP_ID;
      io.write("GitHub App пропущен: добавьте slug, ID и ключ позднее вместе.");
    }
  }
}

async function configureGitLab(io: SetupIO, env: Env): Promise<void> {
  io.write("GitLab OAuth необязателен: настройку можно завершить позже.");
  const baseUrl = await answer(io, "GitLab base URL", env.GITLAB_BASE_URL || "https://gitlab.com");
  if (!isHttpsUrl(baseUrl)) {
    io.write("GitLab URL должен быть HTTPS; настройка GitLab пропущена.");
    return;
  }
  const clientId = await answer(io, "GitLab OAuth client ID (Enter = пропустить)", env.GITLAB_OAUTH_CLIENT_ID);
  if (!clientId) return;
  await optionalSecret(io, env, "GITLAB_OAUTH_CLIENT_SECRET", "GitLab OAuth client secret");
  if (!env.GITLAB_OAUTH_CLIENT_SECRET) {
    delete env.GITLAB_OAUTH_CLIENT_ID;
    io.write("GitLab OAuth пропущен: добавьте client ID и secret позднее вместе.");
    return;
  }
  env.GITLAB_BASE_URL = baseUrl;
  env.GITLAB_OAUTH_CLIENT_ID = clientId;
}

export async function runSetupWizard(io: SetupIO, options: SetupOptions = {}): Promise<Env> {
  const envPath = options.envPath ?? join(options.cwd ?? process.cwd(), ".env");
  const { source, env } = await readSetupEnv(envPath);
  io.write("Настройка .env. Значения секретов не выводятся.");
  env.OWNER_TELEGRAM_ID = await required(io, "Telegram numeric ID владельца", env.OWNER_TELEGRAM_ID ?? "", isPositiveInteger, "Введите положительный целый Telegram ID.");
  const mode = await choose(io, "Режим запуска", ["development", "production"], env.NODE_ENV === "production" ? "production" : "development");
  env.NODE_ENV = mode;
  const telegramChoices = mode === "production" ? ["webhook"] : ["polling", "webhook"];
  const telegramMode = await choose(io, "Telegram transport", telegramChoices, telegramChoices.includes(env.TELEGRAM_MODE) ? env.TELEGRAM_MODE : telegramChoices[0]);
  env.TELEGRAM_MODE = telegramMode;
  await optionalSecret(io, env, "TELEGRAM_TOKEN", "Telegram bot token");
  if (!env.TELEGRAM_TOKEN && mode === "production") io.write("ВНИМАНИЕ: production без TELEGRAM_TOKEN. Добавьте токен до запуска webhook.");
  if (telegramMode === "webhook") {
    const defaultPublicUrl = mode === "development" && env.PUBLIC_URL === "https://bot.example.com" ? "http://localhost:1337" : env.PUBLIC_URL;
    const publicUrl = await required(io, "PUBLIC_URL", defaultPublicUrl, (value) => {
      try {
        return mode !== "production" || new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, mode === "production" ? "В production PUBLIC_URL должен быть корректным HTTPS URL." : "Введите корректный URL.");
    env.PUBLIC_URL = publicUrl;
    await generatedSecret(io, env, "TELEGRAM_WEBHOOK_SECRET", () => generateWebhookSecret(options.random));
  }
  await generatedSecret(io, env, "APP_ENCRYPTION_KEY", () => generateEncryptionKey(options.random));
  env.CODEX_HOME = await answer(io, "CODEX_HOME", env.CODEX_HOME || "/data/codex");
  env.DATABASE_PATH = await answer(io, "DATABASE_PATH", env.DATABASE_PATH || "/data/bot.sqlite");
  env.CONTEXT_MODE = await choose(io, "Режим контекста", ["project_context", "repository"], isContextMode(env.CONTEXT_MODE) ? env.CONTEXT_MODE : "project_context");
  if (env.CONTEXT_MODE === "repository") {
    env.REPOSITORIES_PATH = await answer(io, "REPOSITORIES_PATH", env.REPOSITORIES_PATH || "/data/repositories");
    env.REPOSITORY_REFRESH_TIMEOUT_MS = await answer(io, "REPOSITORY_REFRESH_TIMEOUT_MS", env.REPOSITORY_REFRESH_TIMEOUT_MS || "30000");
  }
  const codexBin = await answer(io, "CODEX_BIN (Enter = codex)", env.CODEX_BIN || "codex");
  env.CODEX_BIN = codexBin;
  const provider = await choose(io, "Какие Git providers настроить сейчас?", ["skip", "github", "gitlab", "both"], "skip") as ProviderSelection;
  if (provider === "github" || provider === "both") await configureGitHub(io, env);
  if (provider === "gitlab" || provider === "both") await configureGitLab(io, env);
  env.HOST = await answer(io, "HOST", env.HOST || "0.0.0.0");
  env.PORT = await required(io, "PORT", env.PORT || "1337", (value) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65_536, "Введите порт от 1 до 65535.");
  await writeEnvAtomically(envPath, serializeDotenv(source, env));
  io.write(".env сохранен с правами 0600.");
  return env;
}
