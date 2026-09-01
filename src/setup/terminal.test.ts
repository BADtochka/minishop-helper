import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readSecret, terminalKeys } from "./terminal";

class FakeInput extends EventEmitter {
  isRaw = false;
  modes: boolean[] = [];
  setRawMode(mode: boolean) { this.isRaw = mode; this.modes.push(mode); }
  resume() {}
  off(event: "data", listener: (chunk: Buffer) => void) { return super.off(event, listener); }
  on(event: "data", listener: (chunk: Buffer) => void) { return super.on(event, listener); }
}

describe("setup terminal helpers", () => {
  test("splits combined arrow and enter chunks", () => {
    expect(terminalKeys(Buffer.from("\u001b[C\r"))).toEqual(["\u001b[C", "\r"]);
  });

  test("reads secrets without echo and restores terminal mode", async () => {
    const input = new FakeInput();
    const output: string[] = [];
    const secret = readSecret(input, { write: (value) => output.push(value) }, "Token: ", () => undefined, () => undefined);
    input.emit("data", Buffer.from("s3cret\r"));
    expect(await secret).toBe("s3cret");
    expect(output.join("")).toBe("Token: \n");
    expect(input.modes).toEqual([true, false]);
  });

  test("restores terminal mode on Ctrl-C", async () => {
    const input = new FakeInput();
    const secret = readSecret(input, { write: () => undefined }, "Token: ", () => undefined, () => undefined);
    input.emit("data", Buffer.from("\u0003"));
    expect(secret).rejects.toThrow("cancelled");
    await secret.catch(() => undefined);
    expect(input.isRaw).toBe(false);
  });
});
