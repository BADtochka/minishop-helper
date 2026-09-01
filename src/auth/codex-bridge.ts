import { consumeSetupSession } from "./setup-session";
import type { AppDatabase } from "../storage/db";
import type { CodexAuthService } from "../codex/auth";
import { randomToken, sha256 } from "../storage/crypto";

const BRIDGE_TTL_MS = 10 * 60 * 1000;

type PendingBridge = { ownerTelegramId: number; expiresAt: number; started: boolean; loginId?: string };

export class CodexBrowserBridge {
  private readonly pending = new Map<string, PendingBridge>();

  constructor(private readonly database: AppDatabase, private readonly ownerTelegramId: number, private readonly codex: CodexAuthService, private readonly now: () => number = Date.now) {}

  async prepare(setupToken: string): Promise<string> {
    this.cleanup();
    const session = await consumeSetupSession(this.database, setupToken, new Date(this.now()));
    if (session.ownerTelegramId !== this.ownerTelegramId) throw new Error("Setup token owner does not match configured owner");
    const state = randomToken();
    this.pending.set(await sha256(state), { ownerTelegramId: session.ownerTelegramId, expiresAt: this.now() + BRIDGE_TTL_MS, started: false });
    return state;
  }

  async start(state: string): Promise<string> {
    const key = await sha256(state);
    const pending = this.pending.get(key);
    if (!pending || pending.expiresAt <= this.now() || pending.ownerTelegramId !== this.ownerTelegramId || pending.started) throw new Error("Codex setup state is invalid, expired, or already used");
    pending.started = true;
    try {
      const login = await this.codex.startBrowserLogin();
      const authUrl = safeAuthUrl(login.authUrl);
      pending.loginId = login.loginId;
      return authUrl;
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
  }

  async status(state: string): Promise<"pending" | "completed"> {
    const pending = this.pending.get(await sha256(state));
    if (!pending || pending.expiresAt <= this.now() || !pending.started || !pending.loginId) throw new Error("Codex setup state is invalid or expired");
    if (!this.codex.isLoginComplete(pending.loginId)) return "pending";
    this.pending.delete(await sha256(state));
    return "completed";
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(key);
  }
}

function safeAuthUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "auth.openai.com" && !url.hostname.endsWith(".openai.com"))) throw new Error("Codex app-server returned an unsafe browser authorization URL");
  return url.toString();
}
