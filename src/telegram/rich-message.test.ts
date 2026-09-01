import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { markdownToTelegramHtml, sendRichMessage } from "./rich-message";

describe("Telegram rich messages", () => {
  test("uses Bot API Rich Messages markdown directly when available", async () => {
    let payload: Record<string, unknown> | undefined;
    const api = { raw: { sendRichMessage: async (value: Record<string, unknown>) => { payload = value; return { message_id: 7 }; } } } as unknown as Api;
    await expect(sendRichMessage(api, "42", "# Heading\n\n- item", { reply_markup: { inline_keyboard: [] } })).resolves.toEqual({ message_id: 7 });
    expect(payload).toMatchObject({ chat_id: "42", rich_message: { markdown: "# Heading\n\n- item" } });
  });

  test("embeds uploaded photos as media blocks at the end of rich markdown", async () => {
    let payload: Record<string, any> | undefined;
    const api = { raw: { sendRichMessage: async (value: Record<string, unknown>) => { payload = value; return { message_id: 8 }; } } } as unknown as Api;
    await sendRichMessage(api, "42", "# Preview", {}, [{ mimeType: "image/png", dataBase64: Buffer.from("image").toString("base64") }]);
    expect(payload?.rich_message.markdown).toBe("# Preview\n\n![](tg://photo?id=preview_image_1)");
    expect(payload?.rich_message.media).toHaveLength(1);
    expect(payload?.rich_message.media[0]).toMatchObject({ id: "preview_image_1", media: { type: "photo" } });
  });

  test("safely renders headings, lists, links, images, and HTML in fallback mode", () => {
    const html = markdownToTelegramHtml("# <Title>\n- [safe](https://example.test/?a=1&b=2)\n![shot](https://example.test/a.png)");
    expect(html).toContain("<b>&lt;Title&gt;</b>");
    expect(html).toContain("• <a href=\"https://example.test/?a=1&amp;b=2\">safe</a>");
    expect(html).toContain("<a href=\"https://example.test/a.png\">shot</a>");
  });
});
