import { describe, expect, test } from "bun:test";
import { hasBotMention, isReplyToProcessableMessage, messageMentionsBot } from "./mentions";

describe("Telegram message validation", () => {
  test("recognizes a bot mention from Telegram entities", () => {
    expect(hasBotMention("hello @MiniShopBot", [{ type: "mention", offset: 6, length: 12 }], "minishopbot")).toBe(true);
    expect(hasBotMention("hello @MiniShopBot", undefined, "minishopbot")).toBe(false);
  });

  test("recognizes caption mentions and replies to captioned messages", () => {
    const message = {
      caption: "please @MiniShopBot",
      caption_entities: [{ type: "mention" as const, offset: 7, length: 12 }],
      reply_to_message: { caption: "A screenshot" },
    };

    expect(messageMentionsBot(message, "minishopbot")).toBe(true);
    expect(isReplyToProcessableMessage(message)).toBe(true);
  });

  test("accepts a reply to an image without a caption", () => {
    expect(isReplyToProcessableMessage({ reply_to_message: { photo: [{ file_id: "small" }, { file_id: "full" }] } })).toBe(true);
  });
});
