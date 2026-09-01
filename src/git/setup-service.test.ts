import { describe, expect, test } from "bun:test";
import { RepositorySetupService } from "./setup-service";
import { RepositoryBindingRepository } from "../storage/repository-bindings";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";

describe("RepositorySetupService", () => {
  test("selects only repositories returned by the owner provider and binds the setup chat", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES (?, ?, ?, ?)").run("gitlab-42", "gitlab", 42, "encrypted");
    const storage = new RepositoryBindingRepository(database);
    const service = new RepositorySetupService(storage, async (owner, provider) => owner === 42 && provider === "gitlab" ? {
      async getCurrentUser() { throw new Error("unused"); },
      async listRepositories() { return [{ id: "99", owner: "team", name: "shop", fullName: "team/shop", description: null, private: true, webUrl: "https://gitlab.example/team/shop", defaultBranch: "main" }]; },
       async getRepository() { throw new Error("unused"); },
       async listBranches() { return ["main", "release/v1"]; },
      async listLabels() { return []; },
      async createIssue() { throw new Error("unused"); },
    } : undefined);

    const repository = await service.select(42, "-100", "gitlab", "99");
    expect(repository).toMatchObject({ provider: "gitlab", fullName: "team/shop", defaultBranch: "main" });
    expect(storage.resolveActive("-100")?.id).toBe(repository.id);
    await expect(service.select(42, "-100", "gitlab", "other")).rejects.toThrow("not available");
  });

  test("falls back to the default branch when the provider returns no branches", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES ('gitlab-42', 'gitlab', 42, 'encrypted')").run();
    const storage = new RepositoryBindingRepository(database);
    const service = new RepositorySetupService(storage, async () => ({
      async getCurrentUser() { throw new Error("unused"); },
      async listRepositories() { return [{ id: "99", owner: "team", name: "shop", fullName: "team/shop", description: null, private: true, webUrl: "https://gitlab.example/team/shop", defaultBranch: "main" }]; },
      async getRepository() { throw new Error("unused"); },
      async listBranches() { return []; },
      async listLabels() { return []; },
      async createIssue() { throw new Error("unused"); },
    }));
    await expect(service.listBranches(42, "gitlab", "99")).resolves.toMatchObject({ branches: ["main"] });
  });
});
