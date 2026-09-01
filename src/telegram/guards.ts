import type { Context } from "grammy";

export function isOwner(userId: number | undefined, ownerTelegramId: number): boolean {
  return userId === ownerTelegramId;
}

export function isAdministratorStatus(status: string): boolean {
  return status === "creator" || status === "administrator";
}

export async function isChatAdministrator(context: Context): Promise<boolean> {
  const chatId = context.chat?.id;
  const userId = context.from?.id;
  if (chatId === undefined || userId === undefined) return false;

  try {
    const member = await context.api.getChatMember(chatId, userId);
    return isAdministratorStatus(member.status);
  } catch {
    // Telegram permission lookups are advisory for webhook delivery: fail closed.
    return false;
  }
}
