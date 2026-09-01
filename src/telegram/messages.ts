import type { Context } from "grammy";
import { isChatAdministrator } from "./guards";
import { imageFileId, isReplyToProcessableMessage, messageMentionsBot, removeBotMention } from "./mentions";

export async function isAcceptedMessage(
  context: Context,
  botUsername: string,
  _ownerTelegramId: number,
): Promise<boolean> {
  const message = context.message;
  if (!message) return false;
  if (!isReplyToProcessableMessage(message) || !messageMentionsBot(message, botUsername)) return false;
  return isChatAdministrator(context);
}

/** Accept a new issue request even when its reply target is an unavailable Rich Message. */
export async function isAcceptedNewRequest(context: Context, botUsername: string): Promise<boolean> {
  const message = context.msg ?? context.message;
  if (!message || !messageMentionsBot(message, botUsername)) return false;
  const content = removeBotMention(message.text ?? message.caption ?? "", botUsername);
  if (!/[\p{L}\p{N}]/u.test(content) && !imageFileId(message)) return false;
  return isChatAdministrator(context);
}
