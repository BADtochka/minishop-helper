import type { AppDatabase } from "../storage/db";
import { createPkceVerifier, randomToken, sha256 } from "../storage/crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

type OAuthStateRow = {
  provider: string;
  owner_telegram_id: number;
  code_verifier: string | null;
  setup_session_id: string | null;
  origin_chat_id: string | null;
  origin_message_id: number | null;
  flow: string | null;
  expires_at: string;
  consumed_at: string | null;
};

export type ConsumedOAuthState = Pick<OAuthStateRow, "provider" | "owner_telegram_id" | "code_verifier" | "setup_session_id" | "origin_chat_id" | "origin_message_id" | "flow">;

export async function createOAuthState(
  database: AppDatabase,
  { provider, ownerTelegramId, setupSessionId, originChatId, originMessageId, flow, codeVerifier = createPkceVerifier() }: { provider: string; ownerTelegramId: number; setupSessionId?: string; originChatId?: string; originMessageId?: number | null; flow?: string; codeVerifier?: string },
  now = new Date(),
): Promise<{ state: string; codeVerifier: string }> {
  const state = randomToken();
  const stateHash = await sha256(state);
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  database.query("INSERT INTO oauth_states (state, provider, owner_telegram_id, code_verifier, setup_session_id, origin_chat_id, origin_message_id, flow, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(stateHash, provider, ownerTelegramId, codeVerifier, setupSessionId ?? null, originChatId ?? null, originMessageId ?? null, flow ?? null, expiresAt);
  return { state, codeVerifier };
}

export async function consumeOAuthState(database: AppDatabase, state: string, now = new Date()): Promise<ConsumedOAuthState> {
  const stateHash = await sha256(state);
  const get = database.query<OAuthStateRow, [string]>("SELECT provider, owner_telegram_id, code_verifier, setup_session_id, origin_chat_id, origin_message_id, flow, expires_at, consumed_at FROM oauth_states WHERE state = ?");
  const consume = database.query("UPDATE oauth_states SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL");

  return database.transaction(() => {
    const record = get.get(stateHash);
    if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= now.getTime()) {
      throw new Error("OAuth state is invalid, expired, or already consumed");
    }
    if (consume.run(now.toISOString(), stateHash).changes !== 1) throw new Error("OAuth state is already consumed");
    return { provider: record.provider, owner_telegram_id: record.owner_telegram_id, code_verifier: record.code_verifier, setup_session_id: record.setup_session_id, origin_chat_id: record.origin_chat_id, origin_message_id: record.origin_message_id, flow: record.flow };
  })();
}
