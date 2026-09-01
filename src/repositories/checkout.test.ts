import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryCheckoutManager, repositoryPath } from "./checkout";

const repository = { id: "provider-id", owner: "acme", name: "shop", fullName: "acme/shop", description: null, private: true, webUrl: "https://example.test/acme/shop", defaultBranch: "main" };
const provider = { getCloneTarget: async () => ({ url: "https://git.example.test/acme/shop.git", env: { GIT_CONFIG_COUNT: "0" } }) };

describe("RepositoryCheckoutManager", () => {
  test("uses a deterministic opaque directory and performs clone, fetch, and hard reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkouts-"));
    const calls: string[][] = [];
    const manager = new RepositoryCheckoutManager({ repositoriesPath: root, timeoutMs: 1_000, runner: async (args) => { calls.push(args); if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true }); } });
    const result = await manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository, provider });
    expect(result.path).toBe(repositoryPath(root, "connection_1", "repository_1"));
    expect(calls).toContainEqual(["clone", "--no-checkout", "--filter=blob:none", "https://git.example.test/acme/shop.git", result.path]);
    expect(calls.some((call) => call.includes("fetch"))).toBe(true);
    expect(calls.some((call) => call.includes("reset") && call.includes("--hard"))).toBe(true);
  });

  test("serializes refreshes for the same repository and rejects unsafe IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkouts-"));
    let active = 0;
    let maximum = 0;
    const manager = new RepositoryCheckoutManager({ repositoriesPath: root, timeoutMs: 1_000, runner: async (args) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true }); active--; } });
    await Promise.all([manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository, provider }), manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository, provider })]);
    expect(maximum).toBe(1);
    expect(() => repositoryPath(root, "../bad", "repository_1")).toThrow();
  });

  test("returns a safe failure when git times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkouts-"));
    const manager = new RepositoryCheckoutManager({ repositoriesPath: root, timeoutMs: 5, runner: async () => await new Promise<void>(() => undefined) });
    await expect(manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository, provider })).rejects.toThrow("Не удалось обновить локальную копию");
  });

  test("reports clone and update stages without exposing the clone URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkouts-"));
    const statuses: string[] = [];
    const manager = new RepositoryCheckoutManager({ repositoriesPath: root, timeoutMs: 1_000, runner: async (args) => { if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true }); } });
    await manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository, provider, progress: (status) => { statuses.push(status); } });
    expect(statuses).toEqual(["⏳ Клонирую репозиторий...", "⏳ Обновляю локальную копию..."]);
    expect(statuses.join(" ")).not.toContain("git.example.test");
  });

  test("checks out the requested branch rather than the repository default", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkouts-"));
    const calls: string[][] = [];
    const manager = new RepositoryCheckoutManager({ repositoriesPath: root, timeoutMs: 1_000, runner: async (args) => { calls.push(args); if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true }); } });
    await manager.refresh({ connectionId: "connection_1", repositoryId: "repository_1", repository: { ...repository, defaultBranch: "release/v1" }, provider });
    expect(calls.some((call) => call.includes("fetch") && call.includes("release/v1"))).toBe(true);
    expect(calls.some((call) => call.includes("checkout") && call.includes("refs/remotes/origin/release/v1"))).toBe(true);
  });
});
