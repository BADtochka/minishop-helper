import { describe, expect, test } from "bun:test";
import { formatLogLine, formatLogRecord } from "./logger";

describe("log formatting", () => {
  test("formats structured records without ANSI escapes", () => {
    expect(formatLogRecord({ level: "info", event: "server.started", timestamp: "2026-01-01T12:34:56.000Z", port: 3000 }, false))
      .toContain("INFO  server.started  port=3000");
  });

  test("parses JSON lines and preserves malformed lines", () => {
    expect(formatLogLine('{"level":"error","event":"job.failed"}', false)).toContain("ERROR job.failed");
    expect(formatLogLine("not-json", false)).toContain("not-json");
  });
});
