import type { AppDatabase } from "./db";

export type StoredRepository = {
  id: string;
  gitConnectionId: string;
  provider: string;
  providerRepositoryId: string;
  fullName: string;
  defaultBranch: string | null;
  branch: string | null;
  webUrl: string | null;
  enabled: boolean;
};

type RepositoryRow = {
  id: string;
  git_connection_id: string;
  provider: string;
  provider_repository_id: string;
  full_name: string;
  default_branch: string | null;
  branch: string | null;
  web_url: string | null;
  enabled: number;
};

export class RepositoryBindingRepository {
  constructor(private readonly database: AppDatabase) {}

  resolveConnection(ownerTelegramId: number, provider: string): { id: string } | null {
    return this.database.query<{ id: string }, [number, string]>(
      "SELECT id FROM git_connections WHERE owner_telegram_id = ? AND provider = ? AND credentials_encrypted IS NOT NULL",
    ).get(ownerTelegramId, provider);
  }

  saveRepository(connectionId: string, repository: Omit<StoredRepository, "id" | "gitConnectionId" | "provider" | "branch" | "enabled"> & { enabled?: boolean }): StoredRepository {
    const existing = this.database.query<{ id: string }, [string, string]>(
      "SELECT id FROM repositories WHERE git_connection_id = ? AND provider_repository_id = ?",
    ).get(connectionId, repository.providerRepositoryId);
    const id = existing?.id ?? crypto.randomUUID();
    this.database.query(`
      INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name, default_branch, web_url, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(git_connection_id, provider_repository_id) DO UPDATE SET
        full_name = excluded.full_name, default_branch = excluded.default_branch, web_url = excluded.web_url, enabled = excluded.enabled
    `).run(id, connectionId, repository.providerRepositoryId, repository.fullName, repository.defaultBranch, repository.webUrl, repository.enabled === false ? 0 : 1);
    return this.getRepository(id)!;
  }

  getRepository(id: string): StoredRepository | null {
    return this.row(`${repositorySelect} WHERE repositories.id = ?`, id);
  }

  listRepositories(ownerTelegramId: number, provider?: string): StoredRepository[] {
    const sql = `${repositorySelect} WHERE git_connections.owner_telegram_id = ?${provider ? " AND git_connections.provider = ?" : ""} ORDER BY repositories.full_name`;
    const rows = provider
      ? this.database.query<RepositoryRow, [number, string]>(sql).all(ownerTelegramId, provider)
      : this.database.query<RepositoryRow, [number]>(sql).all(ownerTelegramId);
    return rows.map(mapRow);
  }

  bind(chatId: string, repositoryId: string, actorOwnerTelegramId: number | null = null, branch?: string | null): void {
    const repository = this.getRepository(repositoryId);
    if (!repository) throw new Error("Repository does not exist");
    if (!repository.enabled) throw new Error("Repository is disabled");
    this.database.transaction(() => {
      this.database.query(`INSERT INTO chat_bindings (chat_id, repository_id, actor_owner_telegram_id, branch) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET repository_id = excluded.repository_id,
        actor_owner_telegram_id = excluded.actor_owner_telegram_id, branch = excluded.branch, updated_at = CURRENT_TIMESTAMP`).run(chatId, repositoryId, actorOwnerTelegramId, branch ?? repository.defaultBranch);
    })();
  }

  unbind(chatId: string): boolean {
    return this.database.query("DELETE FROM chat_bindings WHERE chat_id = ?").run(chatId).changes === 1;
  }

  resolveActive(chatId: string): StoredRepository | null {
    return this.row(`SELECT repositories.id, repositories.git_connection_id, git_connections.provider, repositories.provider_repository_id, repositories.full_name, repositories.default_branch, chat_bindings.branch, repositories.web_url, repositories.enabled
      FROM chat_bindings JOIN repositories ON repositories.id = chat_bindings.repository_id JOIN git_connections ON git_connections.id = repositories.git_connection_id
      WHERE chat_bindings.chat_id = ? AND repositories.enabled = 1 AND git_connections.credentials_encrypted IS NOT NULL`, chatId);
  }

  private row(sql: string, value: string): StoredRepository | null {
    const row = this.database.query<RepositoryRow, [string]>(sql).get(value);
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: RepositoryRow): StoredRepository {
  return { id: row.id, gitConnectionId: row.git_connection_id, provider: row.provider, providerRepositoryId: row.provider_repository_id, fullName: row.full_name, defaultBranch: row.default_branch, branch: row.branch ?? row.default_branch, webUrl: row.web_url, enabled: row.enabled === 1 };
}

const repositorySelect = "SELECT repositories.id, repositories.git_connection_id, git_connections.provider, repositories.provider_repository_id, repositories.full_name, repositories.default_branch, NULL AS branch, repositories.web_url, repositories.enabled FROM repositories JOIN git_connections ON git_connections.id = repositories.git_connection_id";
