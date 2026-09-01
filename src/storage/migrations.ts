import type { AppDatabase } from "./db";

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE processed_updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(id),
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_at TEXT,
        run_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX jobs_next_run_idx ON jobs (status, run_after);
      CREATE TABLE oauth_states (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        code_verifier TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE setup_sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        owner_telegram_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE git_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_name TEXT,
        credentials_encrypted TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        git_connection_id TEXT NOT NULL REFERENCES git_connections(id),
        provider_repository_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (git_connection_id, provider_repository_id)
      );
      CREATE TABLE chat_bindings (
        chat_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE requests ADD COLUMN request_data TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE jobs ADD COLUMN job_data TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE jobs ADD COLUMN error TEXT;
      ALTER TABLE jobs ADD COLUMN provider_started_at TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE oauth_states ADD COLUMN owner_telegram_id INTEGER;
      ALTER TABLE oauth_states ADD COLUMN consumed_at TEXT;
      CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);
      ALTER TABLE setup_sessions ADD COLUMN token_hash TEXT;
      ALTER TABLE setup_sessions ADD COLUMN consumed_at TEXT;
      CREATE UNIQUE INDEX setup_sessions_token_hash_idx ON setup_sessions (token_hash);
      CREATE INDEX setup_sessions_expiry_idx ON setup_sessions (expires_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE git_connections ADD COLUMN owner_telegram_id INTEGER;
      ALTER TABLE git_connections ADD COLUMN provider_account_id TEXT;
      CREATE UNIQUE INDEX git_connections_owner_provider_idx ON git_connections (owner_telegram_id, provider);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE requests ADD COLUMN issue_id TEXT;
      ALTER TABLE requests ADD COLUMN issue_number INTEGER;
      ALTER TABLE requests ADD COLUMN issue_title TEXT;
      ALTER TABLE requests ADD COLUMN issue_url TEXT;
      ALTER TABLE requests ADD COLUMN feedback_message_id INTEGER;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE repositories ADD COLUMN default_branch TEXT;
      ALTER TABLE repositories ADD COLUMN web_url TEXT;
      ALTER TABLE repositories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
      CREATE INDEX repositories_connection_idx ON repositories (git_connection_id);
      CREATE INDEX chat_bindings_repository_idx ON chat_bindings (repository_id);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE oauth_states ADD COLUMN setup_session_id TEXT;
      ALTER TABLE jobs ADD COLUMN recovery_reason TEXT;
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE repositories ADD COLUMN project_context_json TEXT;
      ALTER TABLE repositories ADD COLUMN project_context_fingerprint TEXT;
      ALTER TABLE repositories ADD COLUMN project_context_generated_at TEXT;
      ALTER TABLE repositories ADD COLUMN project_docs_urls TEXT;
      ALTER TABLE requests ADD COLUMN message_thread_id INTEGER;
      ALTER TABLE requests ADD COLUMN source_message_id INTEGER;
      CREATE TABLE issue_previews (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        issue_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_confirmation',
        chat_id TEXT NOT NULL,
        message_thread_id INTEGER,
        source_message_id INTEGER,
        preview_message_id INTEGER,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX issue_previews_status_idx ON issue_previews (status);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE setup_sessions ADD COLUMN flow TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE setup_sessions ADD COLUMN origin_message_id INTEGER;
      ALTER TABLE oauth_states ADD COLUMN origin_chat_id TEXT;
      ALTER TABLE oauth_states ADD COLUMN origin_message_id INTEGER;
      ALTER TABLE oauth_states ADD COLUMN flow TEXT;
      CREATE INDEX setup_sessions_owner_flow_idx ON setup_sessions (owner_telegram_id, flow, expires_at);
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE setup_sessions ADD COLUMN action_hash TEXT;
      CREATE UNIQUE INDEX setup_sessions_action_hash_idx ON setup_sessions (action_hash);
      ALTER TABLE chat_bindings ADD COLUMN message_thread_id INTEGER;
      ALTER TABLE chat_bindings ADD COLUMN actor_owner_telegram_id INTEGER;
      CREATE TABLE observed_chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        is_forum INTEGER NOT NULL DEFAULT 0 CHECK (is_forum IN (0, 1)),
        owner_authorized INTEGER NOT NULL DEFAULT 0 CHECK (owner_authorized IN (0, 1)),
        admin_verified_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE observed_topics (
        chat_id TEXT NOT NULL REFERENCES observed_chats(chat_id) ON DELETE CASCADE,
        message_thread_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        topic_created INTEGER NOT NULL DEFAULT 0 CHECK (topic_created IN (0, 1)),
        observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, message_thread_id)
      );
      CREATE INDEX observed_chats_owner_enabled_idx ON observed_chats (owner_authorized, enabled, updated_at);
    `,
  },
  {
    version: 11,
    sql: `
      -- Bindings are group-wide. Insert oldest first so a legacy topic-specific
      -- table deterministically retains the newest row for each chat.
      CREATE TABLE chat_bindings_new (
        chat_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        actor_owner_telegram_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR REPLACE INTO chat_bindings_new (chat_id, repository_id, actor_owner_telegram_id, created_at, updated_at)
        SELECT chat_id, repository_id, actor_owner_telegram_id, created_at, updated_at
        FROM chat_bindings
        ORDER BY updated_at ASC, rowid ASC;
      DROP TABLE chat_bindings;
      ALTER TABLE chat_bindings_new RENAME TO chat_bindings;
      CREATE INDEX chat_bindings_repository_idx ON chat_bindings (repository_id);
    `,
  },
  {
    version: 12,
    sql: `
      DROP TABLE IF EXISTS observed_topics;
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE issue_previews ADD COLUMN usage_json TEXT;
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE chat_bindings ADD COLUMN branch TEXT;
      UPDATE chat_bindings SET branch = (
        SELECT default_branch FROM repositories WHERE repositories.id = chat_bindings.repository_id
      ) WHERE branch IS NULL;
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE issue_previews ADD COLUMN images_json TEXT;
      ALTER TABLE issue_previews ADD COLUMN image_message_ids_json TEXT;
    `,
  },
  {
    version: 16,
    sql: `
      -- External documentation URL configuration was retired. Existing values
      -- are intentionally ignored so upgrades remain compatible with SQLite.
      SELECT 1;
    `,
  },
];

export function migrate(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = database.query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?");
  const markApplied = database.query("INSERT INTO schema_migrations (version) VALUES (?)");

  database.transaction(() => {
    for (const migration of migrations) {
      if (applied.get(migration.version)) continue;
      database.exec(migration.sql);
      markApplied.run(migration.version);
    }
  })();
}
