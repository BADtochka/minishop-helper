import { CodexClient, type CodexClientOptions, type JsonlTransport } from "./client";
import { resolve } from "node:path";

export interface CodexChildProcess {
  stdin: { write(data: string | Uint8Array): number | void | Promise<number | void>; flush(): number | void | Promise<number | void>; end(error?: Error): number | void | Promise<number | void> } | null;
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export type CodexProcessLauncher = (command: string, args: string[], options: { env: Record<string, string | undefined>; cwd: string }) => CodexChildProcess;

export type CodexProcessManagerOptions = CodexClientOptions & {
  bin?: string;
  home: string;
  workspace: string;
  env?: Record<string, string | undefined>;
  launch?: CodexProcessLauncher;
  onCrash?: (error: Error) => void | Promise<void>;
};

export class CodexProcessManager {
  private child?: CodexChildProcess;
  private client?: CodexClient;
  private stopped = false;

  constructor(private readonly options: CodexProcessManagerOptions) {}

  async start(): Promise<CodexClient> {
    if (this.client) return this.client;
    this.stopped = false;
    // Codex resolves CODEX_HOME relative to its cwd, so always pass absolute paths.
    const home = resolve(this.options.home);
    const workspace = resolve(this.options.workspace);
    await Bun.$`mkdir -p ${home} ${workspace}`.quiet();
    const child = (this.options.launch ?? launchWithBun)(this.options.bin ?? "codex", ["app-server"], {
      env: isolatedEnvironment(home, this.options.env),
      cwd: workspace,
    });
    if (!child.stdin || !child.stdout) throw new Error("Codex app-server must provide stdin and stdout pipes");

    this.child = child;
    this.client = new CodexClient(new ProcessJsonlTransport(child.stdin, child.stdout), { ...this.options, workspace });
    void child.exited.then((exitCode) => this.handleExit(exitCode));
    return this.client;
  }

  async restart(): Promise<CodexClient> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client?.close();
    this.client = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  private async handleExit(exitCode: number): Promise<void> {
    if (this.stopped) return;
    this.client?.close(new Error(`Codex app-server exited with code ${exitCode}`));
    this.client = undefined;
    this.child = undefined;
    await this.options.onCrash?.(new Error(`Codex app-server exited with code ${exitCode}`));
  }
}

class ProcessJsonlTransport implements JsonlTransport {
  private readonly listeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closed = false;

  constructor(private readonly stdin: NonNullable<CodexChildProcess["stdin"]>, stdout: ReadableStream<Uint8Array>) {
    void this.readLines(stdout).catch((error: unknown) => this.emitClose(error instanceof Error ? error : new Error(String(error))));
  }

  async write(line: string): Promise<void> {
    if (this.closed) throw new Error("Codex transport is closed");
    await this.stdin.write(line);
    await this.stdin.flush();
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stdin.end();
  }

  private async readLines(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line) for (const listener of this.listeners) listener(line);
      }
      buffered += decoder.decode();
      if (buffered) for (const listener of this.listeners) listener(buffered);
      this.emitClose(new Error("Codex stdout closed"));
    } finally {
      reader.releaseLock();
    }
  }


  private emitClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}

function launchWithBun(command: string, args: string[], options: { env: Record<string, string | undefined>; cwd: string }): CodexChildProcess {
  return Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: options.env, cwd: options.cwd });
}

function isolatedEnvironment(home: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: Bun.env.PATH,
    LANG: Bun.env.LANG ?? "C.UTF-8",
    ...overrides,
    // Keep HOME for the CLI runtime; its auth state is deliberately selected by CODEX_HOME.
    HOME: Bun.env.HOME,
    CODEX_HOME: home,
  };
}
