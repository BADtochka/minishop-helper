import { describe, expect, test } from "bun:test";
import { isAdministratorStatus, isOwner } from "./guards";

describe("Telegram guards", () => {
  test("matches the owner by numeric Telegram user ID", () => {
    expect(isOwner(123456789, 123456789)).toBe(true);
    expect(isOwner(123456788, 123456789)).toBe(false);
  });

  test("accepts Telegram creator and administrator statuses only", () => {
    expect(isAdministratorStatus("creator")).toBe(true);
    expect(isAdministratorStatus("administrator")).toBe(true);
    expect(isAdministratorStatus("member")).toBe(false);
  });
});
