import type { Api } from "grammy";

export async function cleanupLegacyPreviewImages(api: Pick<Api, "deleteMessage" | "editMessageCaption">, chatId: string, messageIds: readonly number[] | undefined): Promise<void> {
  await Promise.all((messageIds ?? []).map(async (messageId) => {
    await api.editMessageCaption(chatId, messageId, { caption: "Устаревшее изображение предпросмотра." }).catch(() => undefined);
    await api.deleteMessage(chatId, messageId).catch(() => undefined);
  }));
}
