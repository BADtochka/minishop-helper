import { describe, expect, test } from "bun:test";
import { CodexBrowserBridge } from "./codex-bridge";
import { createSetupSession } from "./setup-session";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";

function database() {
  const value = openDatabase(":memory:");
  migrate(value);
  return value;
}

describe("Codex browser bridge", () => {
  test("uses a hashed one-time setup token and reports App Server completion", async () => {
    const db = database();
    const complete = new Set<string>();
    const bridge = new CodexBrowserBridge(db, 42, {
      startBrowserLogin: async () => ({ authUrl: "https://auth.openai.com/authorize", loginId: "login-1" }),
      isLoginComplete: (id: string) => complete.has(id),
    } as never);
    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42 });
    const state = await bridge.prepare(setup.token);

    expect(db.query<{ token_hash: string }, []>("SELECT token_hash FROM setup_sessions").get()?.token_hash).not.toBe(setup.token);
    await expect(bridge.start(state)).resolves.toBe("https://auth.openai.com/authorize");
    await expect(bridge.start(state)).rejects.toThrow("already used");
    expect(await bridge.status(state)).toBe("pending");
    complete.add("login-1");
    expect(await bridge.status(state)).toBe("completed");
    await expect(bridge.status(state)).rejects.toThrow("invalid or expired");
  });

  test("rejects an unsafe authorization redirect and unsupported browser login", async () => {
    const db = database();
    const setup = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42 });
    const unsafe = new CodexBrowserBridge(db, 42, { startBrowserLogin: async () => ({ authUrl: "https://evil.example", loginId: "login-1" }) } as never);
    await expect(unsafe.start(await unsafe.prepare(setup.token))).rejects.toThrow("unsafe");

    const second = await createSetupSession(db, { chatId: "42", ownerTelegramId: 42 });
    const unsupported = new CodexBrowserBridge(db, 42, { startBrowserLogin: async () => { throw new Error("Codex app-server does not support browser login."); } } as never);
    await expect(unsupported.start(await unsupported.prepare(second.token))).rejects.toThrow("does not support browser login");
  });
});
