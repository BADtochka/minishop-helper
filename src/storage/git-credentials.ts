import type { AppDatabase } from "./db";
import { decrypt, encrypt } from "./crypto";

export type CredentialErrorCode = "CREDENTIAL_DECRYPTION_FAILED" | "STORED_CREDENTIALS_INVALID";

export class CredentialError extends Error {
  constructor(
    public readonly code: CredentialErrorCode,
    public readonly provider: "github" | "gitlab",
    public readonly ownerTelegramId: number,
    public readonly phase: "credential_decryption" | "credential_validation",
    options?: ErrorOptions,
  ) {
    super(code === "CREDENTIAL_DECRYPTION_FAILED"
      ? "Stored provider credentials cannot be decrypted"
      : "Stored provider credentials are invalid", options);
    this.name = "CredentialError";
  }
}

export type GitLabCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  baseUrl: string;
};

export type GitHubInstallationCredentials = { installationId: string };

type ConnectionRow = {
  id: string;
  account_name: string | null;
  provider_account_id: string | null;
  credentials_encrypted: string;
};

export class GitCredentialRepository {
  constructor(private readonly database: AppDatabase, private readonly encryptionKey: string) {}

  async saveGitLab(ownerTelegramId: number, accountName: string, credentials: GitLabCredentials): Promise<void> {
    const encrypted = await encrypt(JSON.stringify(credentials), this.encryptionKey);
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO git_connections (id, provider, owner_telegram_id, account_name, provider_account_id, credentials_encrypted)
      VALUES (?, 'gitlab', ?, ?, ?, ?)
      ON CONFLICT(owner_telegram_id, provider) DO UPDATE SET
        account_name = excluded.account_name,
        provider_account_id = excluded.provider_account_id,
        credentials_encrypted = excluded.credentials_encrypted,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, ownerTelegramId, accountName, accountName, encrypted);
  }

  async saveGitHubInstallation(ownerTelegramId: number, accountName: string, installationId: string): Promise<void> {
    const encrypted = await encrypt(JSON.stringify({ installationId }), this.encryptionKey);
    const id = crypto.randomUUID();
    this.database.query(`
      INSERT INTO git_connections (id, provider, owner_telegram_id, account_name, provider_account_id, credentials_encrypted)
      VALUES (?, 'github', ?, ?, ?, ?)
      ON CONFLICT(owner_telegram_id, provider) DO UPDATE SET
        account_name = excluded.account_name,
        provider_account_id = excluded.provider_account_id,
        credentials_encrypted = excluded.credentials_encrypted,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, ownerTelegramId, accountName, installationId, encrypted);
  }

  async getGitLab(ownerTelegramId: number): Promise<GitLabCredentials | undefined> {
    const row = this.connection("gitlab", ownerTelegramId);
    if (!row) return undefined;
    return this.parseGitLab(ownerTelegramId, await this.decrypt("gitlab", ownerTelegramId, row.credentials_encrypted));
  }

  async getGitHubInstallation(ownerTelegramId: number): Promise<GitHubInstallationCredentials | undefined> {
    const row = this.connection("github", ownerTelegramId);
    if (!row) return undefined;
    const value = await this.decrypt("github", ownerTelegramId, row.credentials_encrypted);
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as GitHubInstallationCredentials).installationId !== "string") throw new Error("invalid");
      return parsed as GitHubInstallationCredentials;
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError("STORED_CREDENTIALS_INVALID", "github", ownerTelegramId, "credential_validation", { cause: error });
    }
  }

  async refreshGitLab(
    ownerTelegramId: number,
    refresh: (refreshToken: string) => Promise<Pick<GitLabCredentials, "accessToken" | "refreshToken" | "expiresAt">>,
  ): Promise<GitLabCredentials> {
    const row = this.connection("gitlab", ownerTelegramId);
    if (!row) throw new Error("GitLab connection is not configured");
    const current = this.parseGitLab(ownerTelegramId, await this.decrypt("gitlab", ownerTelegramId, row.credentials_encrypted));
    if (!current.refreshToken) throw new Error("GitLab connection has no refresh token");
    const replacement = await refresh(current.refreshToken);
    const updated = { ...current, ...replacement, refreshToken: replacement.refreshToken ?? current.refreshToken };
    const encrypted = await encrypt(JSON.stringify(updated), this.encryptionKey);
    const result = this.database.query("UPDATE git_connections SET credentials_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND credentials_encrypted = ?")
      .run(encrypted, row.id, row.credentials_encrypted);
    if (result.changes === 1) return updated;
    const concurrent = await this.getGitLab(ownerTelegramId);
    if (!concurrent) throw new Error("GitLab connection is not configured");
    return concurrent;
  }

  private connection(provider: string, ownerTelegramId: number): ConnectionRow | null {
    return this.database.query<ConnectionRow, [string, number]>(`
      SELECT id, account_name, provider_account_id, credentials_encrypted
      FROM git_connections WHERE provider = ? AND owner_telegram_id = ?
    `).get(provider, ownerTelegramId);
  }

  private async decrypt(provider: "github" | "gitlab", ownerTelegramId: number, encrypted: string): Promise<string> {
    try {
      return await decrypt(encrypted, this.encryptionKey);
    } catch (error) {
      throw new CredentialError("CREDENTIAL_DECRYPTION_FAILED", provider, ownerTelegramId, "credential_decryption", { cause: error });
    }
  }

  private parseGitLab(ownerTelegramId: number, value: string): GitLabCredentials {
    try {
      return parseGitLabCredentials(value);
    } catch (error) {
      throw new CredentialError("STORED_CREDENTIALS_INVALID", "gitlab", ownerTelegramId, "credential_validation", { cause: error });
    }
  }
}

function parseGitLabCredentials(value: string): GitLabCredentials {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || typeof (parsed as GitLabCredentials).accessToken !== "string" || typeof (parsed as GitLabCredentials).baseUrl !== "string") {
    throw new Error("Stored GitLab credentials are invalid");
  }
  return parsed as GitLabCredentials;
}

export async function withGitLabRefreshRetry<T>(
  credentials: GitCredentialRepository,
  ownerTelegramId: number,
  refresh: (refreshToken: string) => Promise<Pick<GitLabCredentials, "accessToken" | "refreshToken" | "expiresAt">>,
  operation: (accessToken: string) => Promise<T>,
  shouldRefresh: (error: unknown) => boolean,
): Promise<T> {
  const current = await credentials.getGitLab(ownerTelegramId);
  if (!current) throw new Error("GitLab connection is not configured");
  try {
    return await operation(current.accessToken);
  } catch (error) {
    if (!shouldRefresh(error)) throw error;
  }
  const refreshed = await credentials.refreshGitLab(ownerTelegramId, refresh);
  return operation(refreshed.accessToken);
}
