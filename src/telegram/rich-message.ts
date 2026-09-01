import { InputFile, type Api } from "grammy";
import type { InputRichMessage, InputRichMessageMedia } from "grammy/types";
import type { ImageAttachment } from "../jobs/process-issue";

type MessageOptions = Record<string, unknown>;
type MessageResult = { message_id: number };
type UntypedRawApi = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
const MAX_PREVIEW_IMAGES = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function sendRichMessage(api: Api, chatId: string, markdown: string, options: MessageOptions = {}, images?: readonly ImageAttachment[]): Promise<MessageResult> {
  const raw = api.raw as unknown as UntypedRawApi | undefined;
  if (typeof raw?.sendRichMessage === "function") {
    try {
      return await raw.sendRichMessage({ chat_id: chatId, rich_message: richMessage(markdown, images), ...options }) as MessageResult;
    } catch (error) {
      if (images?.length) throw error;
      // HTML is supported by older Bot API servers and by the current grammY types.
    }
  }
  if (images?.length) throw new Error("Telegram Bot API не поддерживает изображения в rich message.");
  return api.sendMessage(chatId, markdownToTelegramHtml(markdown), { ...options, parse_mode: "HTML" } as never);
}

export async function editRichMessage(api: Api, chatId: string, messageId: number, markdown: string, options: MessageOptions = {}, images?: readonly ImageAttachment[]): Promise<unknown> {
  const raw = api.raw as unknown as UntypedRawApi | undefined;
  if (typeof raw?.editMessageText === "function") {
    try {
      return await raw.editMessageText({ chat_id: chatId, message_id: messageId, rich_message: richMessage(markdown, images), ...options });
    } catch (error) {
      if (images?.length) throw error;
      // Fall through when Rich Messages are unavailable or generated Markdown is invalid.
    }
  }
  if (images?.length) throw new Error("Telegram Bot API не поддерживает изображения в rich message.");
  return api.editMessageText(chatId, messageId, markdownToTelegramHtml(markdown), { ...options, parse_mode: "HTML" } as never);
}

function richMessage(markdown: string, images: readonly ImageAttachment[] | undefined): InputRichMessage {
  const media: InputRichMessageMedia[] = [];
  for (const image of images ?? []) {
    if (media.length === MAX_PREVIEW_IMAGES) break;
    const extension = extensions[image.mimeType];
    const bytes = Buffer.from(image.dataBase64, "base64");
    if (!extension || bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) continue;
    const id = `preview_image_${media.length + 1}`;
    media.push({ id, media: { type: "photo", media: new InputFile(bytes, `${id}.${extension}`) } });
  }
  if (!media.length) return { markdown };
  const imageBlocks = media.map(({ id }) => `![](tg://photo?id=${id})`).join("\n\n");
  return { markdown: `${markdown}\n\n${imageBlocks}`, media };
}

export function escapeRichMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  const rendered: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      rendered.push(inFence ? "</code></pre>" : "<pre><code>");
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      rendered.push(escapeHtml(line));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      rendered.push(`<b>${inlineHtml(heading[1]!)}</b>`);
      continue;
    }
    const list = line.match(/^\s*(?:[-*+] |\d+[.)] )(.+)$/);
    if (list) {
      rendered.push(`• ${inlineHtml(list[1]!)}`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    rendered.push(quote ? `<blockquote>${inlineHtml(quote[1]!)}</blockquote>` : inlineHtml(line));
  }
  if (inFence) rendered.push("</code></pre>");
  return rendered.join("\n");
}

function inlineHtml(value: string): string {
  const tokens: string[] = [];
  const stash = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = value
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, alt: string, url: string) => stash(`<a href="${escapeAttribute(url)}">${escapeHtml(alt || "Image")}</a>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => stash(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? "");
  return text;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
