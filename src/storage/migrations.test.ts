import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "./db";
import { migrate } from "./migrations";

describe("migrate", () => {
  const database = openDatabase(":memory:");

  afterEach(() => {
    database.exec("DROP TABLE IF EXISTS issue_previews; DROP TABLE IF EXISTS observed_topics; DROP TABLE IF EXISTS observed_chats; DROP TABLE IF EXISTS chat_bindings; DROP TABLE IF EXISTS repositories; DROP TABLE IF EXISTS git_connections; DROP TABLE IF EXISTS setup_sessions; DROP TABLE IF EXISTS oauth_states; DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS requests; DROP TABLE IF EXISTS processed_updates; DROP TABLE IF EXISTS schema_migrations;");
  });

  test("creates all foundation tables and can be rerun", () => {
    migrate(database);
    migrate(database);

    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name);

    expect(tables).toEqual(expect.arrayContaining([
      "processed_updates",
      "requests",
      "jobs",
      "oauth_states",
      "setup_sessions",
      "git_connections",
      "repositories",
      "chat_bindings",
      "observed_chats",
    ]));
  });

  test("collapses legacy topic bindings to the most recently updated group binding", () => {
    database.exec(`
      CREATE TABLE repositories (id TEXT PRIMARY KEY, default_branch TEXT);
      INSERT INTO repositories VALUES ('older', 'main'), ('newer', 'main');
      CREATE TABLE chat_bindings (
        chat_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        message_thread_id INTEGER,
        actor_owner_telegram_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_thread_id)
      );
       INSERT INTO chat_bindings VALUES ('-100', 'older', 7, 1, '2026-01-01', '2026-01-01');
       INSERT INTO chat_bindings VALUES ('-100', 'newer', 8, 1, '2026-01-02', '2026-01-02');
       CREATE TABLE issue_previews (request_id TEXT PRIMARY KEY);
       CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    for (let version = 1; version <= 10; version++) database.query("INSERT INTO schema_migrations (version) VALUES (?)").run(version);

    migrate(database);

    expect(database.query("SELECT chat_id, repository_id FROM chat_bindings").all()).toEqual([{ chat_id: "-100", repository_id: "newer" }]);
    expect(database.query("PRAGMA table_info(chat_bindings)").all().map((column: any) => column.name)).not.toContain("message_thread_id");
  });

  test("assigns the repository default branch to existing group bindings", () => {
    database.exec(`
      CREATE TABLE repositories (id TEXT PRIMARY KEY, default_branch TEXT);
      INSERT INTO repositories VALUES ('repository', 'main');
       CREATE TABLE chat_bindings (chat_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, actor_owner_telegram_id INTEGER, created_at TEXT, updated_at TEXT);
       INSERT INTO chat_bindings VALUES ('-100', 'repository', 1, '2026-01-01', '2026-01-01');
       CREATE TABLE issue_previews (request_id TEXT PRIMARY KEY, usage_json TEXT);
       CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    for (let version = 1; version <= 13; version++) database.query("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    migrate(database);
    expect(database.query("SELECT branch FROM chat_bindings WHERE chat_id = '-100'").get()).toEqual({ branch: "main" });
  });
});
