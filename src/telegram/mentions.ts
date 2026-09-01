type MessageEntity = { type: string; offset: number; length: number };

export type ReplyableMessage = {
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string };
};

export type IncomingMessage = ReplyableMessage & {
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  reply_to_message?: ReplyableMessage;
};

export function hasBotMention(
  value: string | undefined,
  entities: MessageEntity[] | undefined,
  username: string,
): boolean {
  if (!value || !entities) return false;
  const expected = `@${username}`.toLowerCase();

  return entities.some(
    (entity) =>
      entity.type === "mention" &&
      value.slice(entity.offset, entity.offset + entity.length).toLowerCase() === expected,
  );
}

export function messageMentionsBot(message: IncomingMessage, username: string): boolean {
  return (
    hasBotMention(message.text, message.entities, username) ||
    hasBotMention(message.caption, message.caption_entities, username)
  );
}

export function removeBotMention(value: string, username: string): string {
  return value.replace(new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), "").replace(/[ \t]+/g, " ").trim();
}

export function isReplyToProcessableMessage(message: IncomingMessage): boolean {
  const repliedMessage = message.reply_to_message;
  return Boolean(repliedMessage && (repliedMessage.text || repliedMessage.caption || imageFileId(repliedMessage)));
}

export function imageFileId(message: ReplyableMessage): string | undefined {
  const photo = message.photo?.at(-1)?.file_id;
  return photo ?? (message.document?.mime_type?.startsWith("image/") ? message.document.file_id : undefined);
}
