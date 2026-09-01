import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CodexProcessManager, type CodexChildProcess } from "./process";

describe("CodexProcessManager", () => {
  test("uses FileSink write/flush/end, isolates env, and rejects pending RPC on exit", async () => {
    const writes: string[] = [];
    let flushes = 0;
    let ended = 0;
    let exit!: (code: number) => void;
    let launchOptions: { env: Record<string, string | undefined>; cwd: string } | undefined;
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const child: CodexChildProcess = {
      stdin: { write(data) { writes.push(String(data)); return String(data).length; }, flush() { flushes++; return 0; }, end() { ended++; return 0; } },
      stdout: stream.readable,
      exited: new Promise((resolve) => { exit = resolve; }),
      kill() {},
    };
    const manager = new CodexProcessManager({
      home: "/tmp/opencode/minishop-codex-home",
      workspace: "/tmp/opencode/minishop-codex-work",
      launch: (_command, _args, options) => { launchOptions = options; return child; },
    });
    const client = await manager.start();
    const pending = client.request("account/read");
    await Promise.resolve();
    expect(writes[0]).toContain("account/read");
    expect(flushes).toBe(1);
    expect(launchOptions?.cwd).toBe("/tmp/opencode/minishop-codex-work");
    expect(launchOptions?.env.TELEGRAM_TOKEN).toBeUndefined();
    expect(launchOptions?.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(launchOptions?.env.CODEX_HOME).toBe("/tmp/opencode/minishop-codex-home");
    exit(7);
    await expect(pending).rejects.toThrow("exited with code 7");
    expect(ended).toBe(1);
  });

  test("uses absolute Codex paths while preserving HOME", async () => {
    let launchOptions: { env: Record<string, string | undefined>; cwd: string } | undefined;
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const child: CodexChildProcess = {
      stdin: { write() { return 0; }, flush() { return 0; }, end() { return 0; } },
      stdout: stream.readable,
      exited: new Promise(() => {}),
      kill() {},
    };
    const manager = new CodexProcessManager({
      home: ".data/codex",
      workspace: ".data/codex-workspace",
      launch: (_command, _args, options) => { launchOptions = options; return child; },
    });

    await manager.start();

    expect(launchOptions?.env.CODEX_HOME).toBe(resolve(".data/codex"));
    expect(launchOptions?.cwd).toBe(resolve(".data/codex-workspace"));
    expect(launchOptions?.env.HOME).toBe(Bun.env.HOME);
    await manager.stop();
  });
});
