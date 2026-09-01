import type { AppDatabase } from "../storage/db";
import { randomToken, sha256 } from "../storage/crypto";

const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;

export type ConsumedSetupSession = { id: string; chatId: string; ownerTelegramId: number; flow: string; originMessageId: number | null };

export class SetupActionError extends Error {
  constructor(public readonly code: "ACTION_EXPIRED" | "ACTION_REPLAYED" | "ACTION_WRONG_CONTEXT") { super(code); this.name = "SetupActionError"; }
}

export class PendingLinkError extends Error {
  constructor(public readonly code: "LINK_MISSING" | "LINK_AMBIGUOUS" | "LINK_REPLAYED") { super(code); this.name = "PendingLinkError"; }
}

export async function createSetupSession(
  database: AppDatabase,
  { id = crypto.randomUUID(), chatId, ownerTelegramId, flow = "legacy", originMessageId = null }: { id?: string; chatId: string; ownerTelegramId: number; flow?: string; originMessageId?: number | null },
  now = new Date(),
): Promise<{ id: string; token: string; action: string }> {
  const token = randomToken();
  const action = randomToken().slice(0, 24);
  const tokenHash = await sha256(token);
  const actionHash = await sha256(action);
  database.query("INSERT INTO setup_sessions (id, chat_id, owner_telegram_id, token_hash, action_hash, flow, origin_message_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, chatId, ownerTelegramId, tokenHash, actionHash, flow, originMessageId, new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString());
  return { id, token, action };
}

export async function consumeSetupSession(database: AppDatabase, token: string, now = new Date()): Promise<ConsumedSetupSession> {
  const tokenHash = await sha256(token);
  const get = database.query<SetupSessionRow, [string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE token_hash = ?");
  const consume = database.query("UPDATE setup_sessions SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL");

  return database.transaction(() => {
    const record = get.get(tokenHash);
    if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= now.getTime()) {
      throw new Error("Setup token is invalid, expired, or already consumed");
    }
    if (consume.run(now.toISOString(), tokenHash).changes !== 1) throw new Error("Setup token is already consumed");
    return map(record);
  })();
}

export async function getSetupSession(database: AppDatabase, token: string, now = new Date()): Promise<ConsumedSetupSession> {
  const tokenHash = await sha256(token);
  const record = database.query<SetupSessionRow, [string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE token_hash = ?").get(tokenHash);
  if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= now.getTime()) throw new Error("Setup token is invalid, expired, or already consumed");
  return map(record);
}

export function consumeSetupSessionById(database: AppDatabase, id: string, now = new Date()): ConsumedSetupSession {
  const get = database.query<SetupSessionRow, [string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE id = ?");
  const consume = database.query("UPDATE setup_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL");
  return database.transaction(() => {
    const record = get.get(id);
    if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= now.getTime() || consume.run(now.toISOString(), id).changes !== 1) throw new Error("Setup action is invalid, expired, or already consumed");
    return map(record);
  })();
}

export async function consumeSetupAction(database: AppDatabase, action: string, expected?: { ownerTelegramId: number; chatId: string; messageId?: number }, now = new Date()): Promise<ConsumedSetupSession> {
  const actionHash = await sha256(action);
  const get = database.query<SetupSessionRow, [string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE action_hash = ?");
  const consume = database.query("UPDATE setup_sessions SET consumed_at = ? WHERE action_hash = ? AND consumed_at IS NULL");
  return database.transaction(() => {
    const record = get.get(actionHash);
    if (!record || new Date(record.expires_at).getTime() <= now.getTime()) throw new SetupActionError("ACTION_EXPIRED");
    if (record.consumed_at) throw new SetupActionError("ACTION_REPLAYED");
    if (expected && (record.owner_telegram_id !== expected.ownerTelegramId || record.chat_id !== expected.chatId || record.origin_message_id !== null && record.origin_message_id !== expected.messageId)) throw new SetupActionError("ACTION_WRONG_CONTEXT");
    if (consume.run(now.toISOString(), actionHash).changes !== 1) throw new SetupActionError("ACTION_REPLAYED");
    return map(record);
  })();
}

export function latestSetupSession(database: AppDatabase, ownerTelegramId: number, flow: string, now = new Date()): ConsumedSetupSession | null {
  const record = database.query<SetupSessionRow, [number, string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE owner_telegram_id = ? AND flow = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(ownerTelegramId, flow);
  return record && new Date(record.expires_at).getTime() > now.getTime() ? map(record) : null;
}

/** Consumes exactly one repository-selection fallback for the setup owner. */
export function consumePendingLink(database: AppDatabase, ownerTelegramId: number, now = new Date()): ConsumedSetupSession {
  const records = database.query<SetupSessionRow, [number, string, string]>("SELECT id, chat_id, owner_telegram_id, flow, origin_message_id, expires_at, consumed_at FROM setup_sessions WHERE owner_telegram_id = ? AND flow LIKE ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 2")
    .all(ownerTelegramId, "link:%", now.toISOString());
  if (!records.length) throw new PendingLinkError("LINK_MISSING");
  if (records.length > 1) throw new PendingLinkError("LINK_AMBIGUOUS");
  const record = records[0]!;
  const consume = database.query("UPDATE setup_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?");
  return database.transaction(() => {
    if (consume.run(now.toISOString(), record.id, now.toISOString()).changes !== 1) throw new PendingLinkError("LINK_REPLAYED");
    return map(record);
  })();
}

type SetupSessionRow = { id: string; chat_id: string; owner_telegram_id: number; flow: string; origin_message_id: number | null; expires_at: string; consumed_at: string | null };
function map(record: SetupSessionRow): ConsumedSetupSession { return { id: record.id, chatId: record.chat_id, ownerTelegramId: record.owner_telegram_id, flow: record.flow, originMessageId: record.origin_message_id }; }
