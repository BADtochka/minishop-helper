import { describe, expect, test } from "bun:test";
import { openDatabase } from "./db";
import { migrate } from "./migrations";
import { CredentialError, GitCredentialRepository, withGitLabRefreshRetry } from "./git-credentials";

describe("GitCredentialRepository", () => {
  test("encrypts credentials and atomically refreshes once after an unauthorized request", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const repository = new GitCredentialRepository(database, "b".repeat(64));
    await repository.saveGitLab(1, "alice", { accessToken: "old", refreshToken: "refresh", baseUrl: "https://gitlab.com" });

    let attempts = 0;
    const value = await withGitLabRefreshRetry(
      repository,
      1,
      async (refreshToken) => ({ accessToken: `new-${refreshToken}`, refreshToken: "refresh-2", expiresAt: "2026-01-01T00:00:00.000Z" }),
      async (accessToken) => {
        attempts++;
        if (accessToken === "old") throw new Error("unauthorized");
        return accessToken;
      },
      (error) => error instanceof Error && error.message === "unauthorized",
    );

    expect(value).toBe("new-refresh");
    expect(attempts).toBe(2);
    expect(await repository.getGitLab(1)).toMatchObject({ accessToken: "new-refresh", refreshToken: "refresh-2" });
    expect(database.query<{ credentials_encrypted: string }, []>("SELECT credentials_encrypted FROM git_connections").get()?.credentials_encrypted).not.toContain("new-refresh");
  });

  test("preserves the existing GitLab refresh token when rotation omits one", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const repository = new GitCredentialRepository(database, "c".repeat(64));
    await repository.saveGitLab(1, "alice", { accessToken: "old", refreshToken: "keep-me", baseUrl: "https://gitlab.com" });
    await repository.refreshGitLab(1, async () => ({ accessToken: "new", refreshToken: undefined }));
    expect(await repository.getGitLab(1)).toMatchObject({ accessToken: "new", refreshToken: "keep-me" });
  });

  test("reports a wrong encryption key without exposing or changing GitLab credentials", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const original = new GitCredentialRepository(database, "d".repeat(64));
    await original.saveGitLab(7, "alice", { accessToken: "access-token", refreshToken: "refresh-token", baseUrl: "https://gitlab.com" });
    const encrypted = database.query<{ credentials_encrypted: string }, []>("SELECT credentials_encrypted FROM git_connections").get()!.credentials_encrypted;
    const wrongKey = new GitCredentialRepository(database, "e".repeat(64));
    let refreshed = false;

    await expect(wrongKey.refreshGitLab(7, async () => {
      refreshed = true;
      return { accessToken: "replacement" };
    })).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPTION_FAILED", provider: "gitlab", phase: "credential_decryption" } satisfies Partial<CredentialError>);

    expect(refreshed).toBe(false);
    expect(database.query<{ credentials_encrypted: string }, []>("SELECT credentials_encrypted FROM git_connections").get()!.credentials_encrypted).toBe(encrypted);
    expect(encrypted).not.toContain("access-token");
    expect(encrypted).not.toContain("refresh-token");
  });

  test("reports malformed ciphertext with the same safe credential error", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.query("INSERT INTO git_connections (id, provider, owner_telegram_id, credentials_encrypted) VALUES ('gitlab', 'gitlab', 8, 'not-ciphertext')").run();
    const repository = new GitCredentialRepository(database, "f".repeat(64));

    await expect(repository.getGitLab(8)).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPTION_FAILED", provider: "gitlab", phase: "credential_decryption" } satisfies Partial<CredentialError>);
  });
});
