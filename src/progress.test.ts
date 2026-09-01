import { describe, expect, test } from "bun:test";
import { throttledProgress } from "./progress";

describe("throttledProgress", () => {
  test("bounds Telegram updates and message length", async () => {
    let now = 0;
    const statuses: string[] = [];
    const progress = throttledProgress((status) => { statuses.push(status); }, 750, () => now);
    await progress("first");
    now = 100; await progress("too soon");
    now = 800; await progress("x".repeat(5000));
    expect(statuses).toEqual(["first", "x".repeat(4096)]);
  });
});
