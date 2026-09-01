import { expect, test } from "bun:test";
import { loadConfig } from "./config";

test("does not expose PROJECT_DOCS_URLS runtime configuration", () => {
  const config = loadConfig({ OWNER_TELEGRAM_ID: "1", PROJECT_DOCS_URLS: "https://untrusted.example/docs" });
  expect(config).not.toHaveProperty("PROJECT_DOCS_URLS");
});
