import { describe, expect, test } from "bun:test";
import { CodexRpcError, type JsonRpcNotification } from "./client";
import { CodexAuthError, CodexAuthService, maskAccount } from "./auth";

class FakeCodexClient {
  notifications = new Set<(notification: JsonRpcNotification) => void>();
  loggedOut = false;
  loginResult: unknown = { verificationUrl: "https://auth.example/device", userCode: "ABCD-EFGH" };
  accountResult: unknown = { account: { email: "owner@example.com", planType: "pro" } };

  async initialize(): Promise<void> {}
  async accountRead(): Promise<unknown> { return this.accountResult; }
  async startDeviceLogin(): Promise<unknown> { return this.loginResult; }
  async startBrowserLogin(): Promise<unknown> { return { type: "chatgpt", authUrl: "https://auth.openai.com/authorize", loginId: "login-1" }; }
  async logout(): Promise<void> { this.loggedOut = true; }
  async generateIssue(): Promise<never> { throw new Error("not used"); }
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  notify(method: string, params?: unknown): void {
    for (const listener of this.notifications) listener({ method, params });
  }
}

describe("CodexAuthService", () => {
  test("starts a device-code login and processes its completion notification", async () => {
    const client = new FakeCodexClient();
    const notifications: string[] = [];
    const service = new CodexAuthService(async () => client, undefined, async () => { notifications.push("completed"); });

    await expect(service.startDeviceLogin()).resolves.toEqual({ verificationUrl: "https://auth.example/device", userCode: "ABCD-EFGH" });
    client.notify("account/login/completed");
    await Promise.resolve();

    expect(service.wasLoginCompleted()).toBe(true);
    expect(notifications).toEqual(["completed"]);
  });

  test("starts browser login and tracks its matching completion notification", async () => {
    const client = new FakeCodexClient();
    const service = new CodexAuthService(async () => client);
    await expect(service.startBrowserLogin()).resolves.toEqual({ authUrl: "https://auth.openai.com/authorize", loginId: "login-1" });
    client.notify("account/login/completed", { loginId: "login-1" });
    expect(service.isLoginComplete("login-1")).toBe(true);
  });

  test("notifies only once for duplicate browser and device completion notifications", async () => {
    const client = new FakeCodexClient();
    const notifications: string[] = [];
    const service = new CodexAuthService(async () => client, undefined, async () => { notifications.push("completed"); });

    await service.startBrowserLogin();
    client.notify("account/login/completed", { loginId: "login-1" });
    client.notify("account/login/completed", { loginId: "login-1" });
    await service.startDeviceLogin();
    client.notify("account/login/completed");
    client.notify("account/login/completed");
    await Promise.resolve();

    expect(notifications).toEqual(["completed", "completed"]);
  });

  test("reads a masked account status and logs out", async () => {
    const client = new FakeCodexClient();
    const service = new CodexAuthService(async () => client);

    expect(maskAccount(await service.readStatus())).toBe("connected (o***@example.com, pr***)");
    await service.logout();

    expect(client.loggedOut).toBe(true);
  });

  test("reports authorization required for a working app-server with no account", async () => {
    const client = new FakeCodexClient();
    client.accountResult = { account: null, requiresOpenaiAuth: true };
    const service = new CodexAuthService(async () => client);

    await expect(service.readStatus()).resolves.toEqual({ state: "authorization_required" });
  });

  test("emits a safe diagnostic code for runtime failures", async () => {
    const client = new FakeCodexClient();
    client.accountResult = Promise.reject(new Error("Codex stdout closed with token secret-value"));
    const diagnostics: unknown[] = [];
    const service = new CodexAuthService(async () => client, (event) => diagnostics.push(event));

    await expect(service.readStatus()).resolves.toEqual({ state: "unavailable" });
    expect(diagnostics).toEqual([{ phase: "account_read", errorCode: "CODEX_PROCESS_CLOSED" }]);
  });

  test("reports disabled device-code login without exposing RPC details", async () => {
    const client = new FakeCodexClient();
    client.loginResult = Promise.reject(new CodexRpcError({ code: -1, message: "Device code login disabled", data: { token: "secret" } }));
    const service = new CodexAuthService(async () => client);

    await expect(service.startDeviceLogin()).rejects.toMatchObject({ code: "CODEX_LOGIN_DISABLED" } satisfies Partial<CodexAuthError>);
  });

  test("contains notifier failures without leaking secrets", async () => {
    const client = new FakeCodexClient();
    const diagnostics: unknown[] = [];
    const service = new CodexAuthService(
      async () => client,
      (event) => diagnostics.push(event),
      async () => { throw new Error("Telegram rejected token secret-value"); },
    );

    await service.startDeviceLogin();
    client.notify("account/login/completed");
    await Promise.resolve();

    expect(service.wasLoginCompleted()).toBe(true);
    expect(diagnostics).toEqual([{ phase: "login_notification", errorCode: "CODEX_RUNTIME_FAILURE" }]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
  });
});
