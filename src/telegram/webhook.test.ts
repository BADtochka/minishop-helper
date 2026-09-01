import { describe, expect, test } from "bun:test";
import { handleTelegramWebhook, isWebhookSecretValid } from "./webhook";

describe("Telegram webhook secret", () => {
  test("requires an exact configured secret", () => {
    expect(isWebhookSecretValid("expected", "expected")).toBe(true);
    expect(isWebhookSecretValid(null, "expected")).toBe(false);
    expect(isWebhookSecretValid("wrong", "expected")).toBe(false);
    expect(isWebhookSecretValid("expected", undefined)).toBe(false);
  });

  test("rejects a webhook request without a valid secret", async () => {
    const response = await handleTelegramWebhook(
      new Request("http://localhost/telegram/webhook", { method: "POST" }),
      undefined,
      "expected",
    );

    expect(response.status).toBe(401);
  });

  test("returns conflict before processing webhook requests in polling mode", async () => {
    const response = await handleTelegramWebhook(
      new Request("http://localhost/telegram/webhook", { method: "POST" }),
      undefined,
      undefined,
      undefined,
      "polling",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "polling_enabled" });
  });

  test("returns a controlled failure when update processing throws", async () => {
    const response = await handleTelegramWebhook(
      new Request("http://localhost/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "expected" }, body: JSON.stringify({ update_id: 10 }) }),
      { handleUpdate: async () => { throw new Error("access_token=must-not-leak"); } } as any,
      "expected",
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "update_processing_failed" });
  });
});
