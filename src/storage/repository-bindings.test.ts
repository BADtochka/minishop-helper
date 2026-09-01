import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db";
import { migrate } from "./migrations";
import { RepositoryBindingRepository } from "./repository-bindings";

describe("RepositoryBindingRepository", () => {
  test("persists repository metadata, resolves active bindings, and enforces foreign keys", () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES (?, ?, ?, ?)").run("connection", "gitlab", 42, "encrypted");
    const bindings = new RepositoryBindingRepository(database);
    const repository = bindings.saveRepository("connection", { providerRepositoryId: "100", fullName: "team/shop", defaultBranch: "main", webUrl: "https://gitlab/team/shop" });
    bindings.bind("-100", repository.id, null, "release/v1");
    expect(bindings.resolveActive("-100")).toMatchObject({ id: repository.id, provider: "gitlab", fullName: "team/shop", defaultBranch: "main", branch: "release/v1", enabled: true });
    database.query("UPDATE repositories SET enabled = 0 WHERE id = ?").run(repository.id);
    expect(bindings.resolveActive("-100")).toBeNull();
    expect(() => bindings.bind("-101", "missing")).toThrow("Repository does not exist");
  });

  test("uses the repository default branch for bindings created before branch selection", () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES ('connection', 'gitlab', 42, 'encrypted')").run();
    const bindings = new RepositoryBindingRepository(database);
    const repository = bindings.saveRepository("connection", { providerRepositoryId: "100", fullName: "team/shop", defaultBranch: "main", webUrl: null });
    bindings.bind("-100", repository.id);
    expect(bindings.resolveActive("-100")?.branch).toBe("main");
  });

  test("resolves connections only for the requested owner and provider", () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES (?, ?, ?, ?)").run("github", "github", 42, "encrypted");
    const bindings = new RepositoryBindingRepository(database);
    expect(bindings.resolveConnection(42, "github")?.id).toBe("github");
    expect(bindings.resolveConnection(7, "github")).toBeNull();
    expect(bindings.resolveConnection(42, "gitlab")).toBeNull();
  });

  test("uses one group binding across forum topics and replaces it from any topic", () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES ('connection', 'gitlab', 42, 'encrypted')").run();
    const bindings = new RepositoryBindingRepository(database);
    const first = bindings.saveRepository("connection", { providerRepositoryId: "100", fullName: "team/first", defaultBranch: "main", webUrl: null });
    const second = bindings.saveRepository("connection", { providerRepositoryId: "101", fullName: "team/second", defaultBranch: "main", webUrl: null });

    bindings.bind("-100", first.id, 42);
    expect(bindings.resolveActive("-100")?.id).toBe(first.id);
    bindings.bind("-100", second.id, 42);
    expect(bindings.resolveActive("-100")?.id).toBe(second.id);
    expect(database.query("SELECT COUNT(*) AS count FROM chat_bindings WHERE chat_id = '-100'").get()).toEqual({ count: 1 });
  });
});
