import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitProvider } from "../git/provider";
import type { GitRepository } from "../git/types";
import { reportProgress, type ProgressReporter } from "../progress";
import { collectRepositoryDocs } from "../context/source-collector";

export type GitRunner = (args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) => Promise<void>;

export class RepositoryCheckoutError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryCheckoutError"; }
}

const locks = new Map<string, Promise<void>>();

export function repositoryPath(repositoriesPath: string, connectionId: string, repositoryId: string): string {
  if (!isOpaqueId(connectionId) || !isOpaqueId(repositoryId)) throw new RepositoryCheckoutError("Invalid internal repository identifier");
  return join(resolve(repositoriesPath), `${connectionId}-${repositoryId}`);
}

export class RepositoryCheckoutManager {
  constructor(private readonly options: { repositoriesPath: string; timeoutMs: number; runner?: GitRunner }) {}

  async refresh(input: { connectionId: string; repositoryId: string; repository: GitRepository; provider: Pick<GitProvider, "getCloneTarget">; progress?: ProgressReporter }): Promise<{ path: string; branch: string; docs: Array<{ sourceId: string; text: string }> }> {
    const path = repositoryPath(this.options.repositoriesPath, input.connectionId, input.repositoryId);
    await mkdir(this.options.repositoriesPath, { recursive: true });
    return this.withLock(path, async () => {
      const branch = input.repository.defaultBranch;
      if (!branch || !isBranch(branch)) throw new RepositoryCheckoutError("У репозитория не указана безопасная ветка по умолчанию.");
      const target = await input.provider.getCloneTarget?.(input.repository);
      if (!target || !isSafeCloneUrl(target.url)) throw new RepositoryCheckoutError("Provider не поддерживает безопасный доступ для клонирования репозитория.");
      if (await this.isCorrupt(path)) await this.quarantine(path);
      if (!await exists(path)) { await reportProgress(input.progress, "⏳ Клонирую репозиторий..."); await this.run(["clone", "--no-checkout", "--filter=blob:none", target.url, path], target.env); }
      await reportProgress(input.progress, "⏳ Обновляю локальную копию...");
      await this.run(["-C", path, "fetch", "--prune", "origin", branch], target.env);
      await this.run(["-C", path, "rev-parse", "--verify", `refs/remotes/origin/${branch}`], target.env);
      await this.run(["-C", path, "checkout", "--force", "-B", branch, `refs/remotes/origin/${branch}`], target.env);
      await this.run(["-C", path, "reset", "--hard", `refs/remotes/origin/${branch}`], target.env);
      await this.run(["-C", path, "clean", "-ffd"], target.env);
      return { path, branch, docs: await collectRepositoryDocs(path) };
    });
  }

  private async isCorrupt(path: string): Promise<boolean> {
    if (!await exists(path)) return false;
    try { await this.run(["-C", path, "rev-parse", "--is-inside-work-tree"], {}); return false; } catch { return true; }
  }

  private async quarantine(path: string): Promise<void> {
    const quarantined = `${path}.corrupt-${Date.now()}`;
    try { await rename(path, quarantined); } catch { await rm(path, { recursive: true, force: true }); }
  }

  private async run(args: string[], env: Record<string, string>): Promise<void> {
    const runner = this.options.runner ?? bunGitRunner;
    const controller = new AbortController();
    try { await withTimeout(runner(args, { env, timeoutMs: this.options.timeoutMs, signal: controller.signal }), this.options.timeoutMs, () => controller.abort()); }
    catch (error) {
      if (error instanceof RepositoryCheckoutError && error.message !== "Repository refresh timed out") throw error;
      throw new RepositoryCheckoutError("Не удалось обновить локальную копию репозитория. Проверьте доступ Git provider и повторите позже.");
    }
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    const lockPath = `${key}.lock`;
    let acquired = false;
    try {
      await acquireFileLock(lockPath, this.options.timeoutMs);
      acquired = true;
      return await operation();
    } finally {
      if (acquired) await rm(lockPath, { recursive: true, force: true });
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }
}

async function bunGitRunner(args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd: options.cwd, env: { ...Bun.env, ...options.env }, stdout: "ignore", stderr: "ignore" });
  options.signal?.addEventListener("abort", () => process.kill(), { once: true });
  const code = await process.exited;
  if (code !== 0) throw new Error("git command failed");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: Timer | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new RepositoryCheckoutError("Repository refresh timed out")); }, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function acquireFileLock(path: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { await mkdir(path); return; } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(path);
        if (Date.now() - metadata.mtimeMs > timeoutMs) { await rm(path, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - started >= timeoutMs) throw new RepositoryCheckoutError("Не удалось дождаться блокировки локального репозитория.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
function isOpaqueId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isBranch(value: string): boolean { return !value.startsWith("-") && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) && !value.includes("..") && !value.endsWith("/"); }
function isSafeCloneUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }
