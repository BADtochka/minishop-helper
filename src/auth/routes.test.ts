import { describe, expect, test } from "bun:test";
import { createAuthRoutes } from "./routes";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { decrypt } from "../storage/crypto";
import { createSetupSession } from "./setup-session";

const encryptionKey = "a".repeat(64);
const config = {
  OWNER_TELEGRAM_ID: 42,
  PUBLIC_URL: "https://bot.example.com",
  APP_ENCRYPTION_KEY: encryptionKey,
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_OAUTH_CLIENT_ID: "client-id",
  GITLAB_OAUTH_CLIENT_SECRET: "client-secret",
  GITHUB_APP_SLUG: "helper-app",
};

function database() {
  const value = openDatabase(":memory:");
  migrate(value);
  return value;
}

describe("auth routes", () => {
  test("creates a GitLab PKCE authorization redirect and exchanges it once", async () => {
    const db = database();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const routes = createAuthRoutes({
      database: db,
      config,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
        return Response.json({ id: 9, username: "octavia" });
      },
    });

    const notifications: string[] = [];
    const notifyingRoutes = createAuthRoutes({ database: db, config, fetch: routesFetch(calls), notifyOwner: async (_chat, text) => { notifications.push(text); } });
    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42, flow: "oauth:gitlab", originMessageId: 7 });
    const start = await notifyingRoutes(new Request(`https://bot.example.com/auth/gitlab/start?token=${setup.token}`));
    expect(start?.status).toBe(302);
    const redirect = new URL(start?.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe("https://gitlab.example.com/oauth/authorize");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    const state = redirect.searchParams.get("state")!;

    const callback = await notifyingRoutes(new Request(`https://bot.example.com/auth/gitlab/callback?state=${encodeURIComponent(state)}&code=never-log-this`));
    expect(callback?.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(notifications).toEqual(["GitLab подключён. Можно выбрать репозиторий."]);
    const tokenForm = new URLSearchParams(String(calls[0].init?.body));
    expect(tokenForm.get("code")).toBe("never-log-this");
    expect(tokenForm.get("code_verifier")).toBeTruthy();
    expect(tokenForm.get("code_challenge")).toBeNull();

    const stored = db.query<{ credentials_encrypted: string; owner_telegram_id: number }, []>("SELECT credentials_encrypted, owner_telegram_id FROM git_connections WHERE provider = 'gitlab'").get();
    expect(stored?.owner_telegram_id).toBe(42);
    expect(stored?.credentials_encrypted).not.toContain("access-secret");
    expect(JSON.parse(await decrypt(stored!.credentials_encrypted, encryptionKey))).toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret", baseUrl: config.GITLAB_BASE_URL });

    const replay = await routes(new Request(`https://bot.example.com/auth/gitlab/callback?state=${encodeURIComponent(state)}&code=second`));
    expect(replay?.status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  test("maps a GitHub installation to the state owner without a PAT", async () => {
    const db = database();
    const installations: string[] = [];
    const routes = createAuthRoutes({ database: db, config, githubApp: { async getInstallation(id) { installations.push(id); return { accountName: "mini-shop" }; }, async createInstallationToken() { return "unused"; } } });

    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42, flow: "oauth:github" });
    const start = await routes(new Request(`https://bot.example.com/auth/github/start?token=${setup.token}`));
    const redirect = new URL(start?.headers.get("location")!);
    expect(redirect.pathname).toBe("/apps/helper-app/installations/new");
    const callback = await routes(new Request(`https://bot.example.com/auth/github/callback?state=${redirect.searchParams.get("state")}&installation_id=1234`));

    expect(callback?.status).toBe(200);
    expect(installations).toEqual(["1234"]);
    expect(db.query<{ owner_telegram_id: number; account_name: string; provider_account_id: string }, []>("SELECT owner_telegram_id, account_name, provider_account_id FROM git_connections WHERE provider = 'github'").get()).toEqual({ owner_telegram_id: 42, account_name: "mini-shop", provider_account_id: "1234" });
  });

  test("rejects public provider starts and consumes an owner setup token once", async () => {
    const db = database();
    const routes = createAuthRoutes({ database: db, config });
    expect((await routes(new Request("https://bot.example.com/auth/gitlab/start")))?.status).toBe(400);
    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42, flow: "oauth:gitlab" });
    expect((await routes(new Request(`https://bot.example.com/auth/gitlab/start?token=${setup.token}`)))?.status).toBe(302);
    expect((await routes(new Request(`https://bot.example.com/auth/gitlab/start?token=${setup.token}`)))?.status).toBe(400);
  });

  test("removes web setup pages", async () => {
    const db = database();
    const routes = createAuthRoutes({ database: db, config });
    expect((await routes(new Request("https://bot.example.com/setup")))?.status).toBe(410);
    expect((await routes(new Request("https://bot.example.com/setup/repositories")))?.status).toBe(410);
  });

  test("reports an OAuth provider failure to the originating Telegram chat safely", async () => {
    const db = database();
    const notifications: string[] = [];
    const routes = createAuthRoutes({ database: db, config, fetch: async () => { throw new Error("request failed access_token=must-not-leak"); }, notifyOwner: async (_chat, text) => { notifications.push(text); } });
    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42, flow: "oauth:gitlab" });
    const start = await routes(new Request(`https://bot.example.com/auth/gitlab/start?token=${setup.token}`));
    const state = new URL(start?.headers.get("location")!).searchParams.get("state");

    const callback = await routes(new Request(`https://bot.example.com/auth/gitlab/callback?state=${state}&code=sensitive-code`));

    expect(callback?.status).toBe(502);
    expect(notifications.at(-1)).toContain("Не удалось завершить авторизацию");
    expect(notifications.join(" ")).not.toContain("must-not-leak");
    expect(JSON.stringify(await callback?.json())).not.toContain("sensitive-code");
  });

});

function routesFetch(calls: Array<{ url: string; init?: RequestInit }>) {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
    return Response.json({ id: 9, username: "octavia" });
  };
}
