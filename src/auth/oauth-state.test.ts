import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { consumeOAuthState, createOAuthState } from "./oauth-state";

describe("OAuth states", () => {
  const database = openDatabase(":memory:");
  afterEach(() => database.exec("DELETE FROM oauth_states"));

  test("consumes a state once and retains its connection context", async () => {
    migrate(database);
    const created = await createOAuthState(database, { provider: "gitlab", ownerTelegramId: 123, codeVerifier: "verifier" });
    await expect(consumeOAuthState(database, created.state)).resolves.toMatchObject({ provider: "gitlab", owner_telegram_id: 123, code_verifier: "verifier", setup_session_id: null, origin_chat_id: null });
    await expect(consumeOAuthState(database, created.state)).rejects.toThrow("already consumed");
  });

  test("rejects expired states", async () => {
    migrate(database);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = await createOAuthState(database, { provider: "gitlab", ownerTelegramId: 123 }, now);
    await expect(consumeOAuthState(database, created.state, new Date(now.getTime() + 10 * 60 * 1000))).rejects.toThrow("expired");
  });
});
