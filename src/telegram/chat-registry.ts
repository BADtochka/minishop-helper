import type { Context } from "grammy";
import type { AppDatabase } from "../storage/db";
import { isAdministratorStatus } from "./guards";

export type ObservedChat = { chatId: string; title: string; type: string; isForum: boolean };

export class ChatRegistry {
  constructor(private readonly database: AppDatabase) {}

  async observe(context: Context, ownerTelegramId: number, botTelegramId: number): Promise<void> {
    const message = context.message ?? context.editedMessage ?? context.channelPost ?? context.editedChannelPost;
    const chat = message?.chat;
    if (!message || !chat || chat.type === "private") return;
    try {
      const [bot, owner] = await Promise.all([
        context.api.getChatMember(chat.id, botTelegramId),
        context.api.getChatMember(chat.id, ownerTelegramId),
      ]);
      if (!isAdministratorStatus(bot.status) || !isAdministratorStatus(owner.status)) return;
    } catch {
      return;
    }
    this.store(message, chat);
  }

  async registerLink(context: Context, requesterTelegramId: number, botTelegramId: number): Promise<boolean> {
    const message = context.message;
    const chat = message?.chat;
    if (!message || !chat || (chat.type !== "group" && chat.type !== "supergroup")) return false;
    try {
      const [bot, requester] = await Promise.all([
        context.api.getChatMember(chat.id, botTelegramId),
        context.api.getChatMember(chat.id, requesterTelegramId),
      ]);
      if (!isAdministratorStatus(bot.status) || !isAdministratorStatus(requester.status)) return false;
    } catch {
      return false;
    }
    this.store(message, chat);
    return true;
  }

  private store(_message: object, chat: { id: number; type: string; title?: string; is_forum?: boolean }): void {
    const title = "title" in chat && chat.title ? chat.title : `Чат ${chat.id}`;
    const now = new Date().toISOString();
    this.database.query(`INSERT INTO observed_chats (chat_id, title, type, is_forum, owner_authorized, admin_verified_at, enabled, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, type = excluded.type,
      is_forum = excluded.is_forum, owner_authorized = 1, admin_verified_at = excluded.admin_verified_at, enabled = 1, updated_at = excluded.updated_at`)
      .run(String(chat.id), title, chat.type, "is_forum" in chat && chat.is_forum ? 1 : 0, now, now);

  }

  listChats(): ObservedChat[] {
    return this.database.query<{ chat_id: string; title: string; type: string; is_forum: number }, []>(
      "SELECT chat_id, title, type, is_forum FROM observed_chats WHERE enabled = 1 AND owner_authorized = 1 ORDER BY title",
    ).all().map((row) => ({ chatId: row.chat_id, title: row.title, type: row.type, isForum: row.is_forum === 1 }));
  }

  getChat(chatId: string): ObservedChat | null {
    return this.listChats().find((chat) => chat.chatId === chatId) ?? null;
  }
}
