import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "./router";
import { openDatabase } from "../storage/db";

const database = openDatabase(":memory:");
const router = createRouter(database, { mode: "webhook", status: "not_configured", activate: async () => undefined, stop: async () => undefined });

afterEach(() => {
  // The shared in-memory connection stays available for subsequent requests.
});

describe("server router", () => {
  test("reports process health without requiring migrations", async () => {
    const response = await router(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("reports database readiness without exposing configuration", async () => {
    const response = await router(new Request("http://localhost/ready"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", database: "ready", telegram: "not_configured" });
  });
});
