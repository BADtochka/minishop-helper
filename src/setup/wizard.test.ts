import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEncryptionKey, generateWebhookSecret, isContextMode, isPositiveInteger, isProviderSelection, parseDotenv, runSetupWizard, serializeDotenv } from "./wizard";

const deterministic = (size: number) => new Uint8Array(size).fill(7);

function fakeIo(answers: string[]) {
  const output: string[] = [];
  return {
    output,
    ask: async () => answers.shift() ?? "",
    write: (message: string) => output.push(message),
  };
}

describe("setup wizard helpers", () => {
  test("generates correctly shaped local secrets", () => {
    expect(generateWebhookSecret(deterministic)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(generateEncryptionKey(deterministic), "base64")).toHaveLength(32);
  });

  test("validates IDs and provider choices", () => {
    expect(isPositiveInteger("123")).toBe(true);
    expect(isPositiveInteger("0")).toBe(false);
    expect(isPositiveInteger("1.5")).toBe(false);
    expect(isProviderSelection("github")).toBe(true);
    expect(isProviderSelection("bitbucket")).toBe(false);
    expect(isContextMode("repository")).toBe(true);
  });

  test("preserves comments while serializing updated variables", () => {
    const source = "# Keep this\nTOKEN=old\nEMPTY=\n";
    const result = serializeDotenv(source, { TOKEN: "new value", ADDED: "yes" });
    expect(result).toContain("# Keep this\nTOKEN=\"new value\"");
    expect(parseDotenv(result)).toMatchObject({ TOKEN: "new value", EMPTY: "", ADDED: "yes" });
  });
});

describe("runSetupWizard", () => {
  test("does not overwrite existing generated secrets without confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-"));
    const path = join(directory, ".env");
    await Bun.write(path, "TELEGRAM_WEBHOOK_SECRET=keep-webhook\nAPP_ENCRYPTION_KEY=keep-key\n");
    const io = fakeIo(["1", "development", "", "", "n", "", "", "", "skip", "", ""]);
    const env = await runSetupWizard(io, { envPath: path, random: deterministic });
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe("keep-webhook");
    expect(env.APP_ENCRYPTION_KEY).toBe("keep-key");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("configures only selected GitHub provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-"));
    const path = join(directory, ".env");
    const io = fakeIo(["1", "development", "", "", "", "", "", "", "github", "my-app", "42", "/run/secrets/github.pem", "", ""]);
    const env = await runSetupWizard(io, { envPath: path, random: deterministic });
    expect(env).toMatchObject({ GITHUB_APP_SLUG: "my-app", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github.pem" });
    expect(env.GITLAB_OAUTH_CLIENT_ID).toBeUndefined();
  });

  test("configures selected GitLab provider without exposing its secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-"));
    const path = join(directory, ".env");
    const io = fakeIo(["1", "development", "", "", "", "", "", "", "gitlab", "https://gitlab.example", "client", "secret", "", ""]);
    const env = await runSetupWizard(io, { envPath: path, random: deterministic });
    expect(env).toMatchObject({ GITLAB_BASE_URL: "https://gitlab.example", GITLAB_OAUTH_CLIENT_ID: "client", GITLAB_OAUTH_CLIENT_SECRET: "secret" });
    expect(io.output.join("\n")).not.toContain("secret");
    expect(await readFile(path, "utf8")).toContain("GITLAB_OAUTH_CLIENT_SECRET=secret");
  });

  test("uses discrete selections when the terminal supports arrow choices", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-"));
    const path = join(directory, ".env");
    const answers = ["1", "", "", "", "", "", ""];
    const selected: string[] = [];
    const io = {
      ask: async () => answers.shift() ?? "",
      select: async (prompt: string, choices: string[]) => {
        const value = prompt === "Режим запуска" ? "development" : prompt === "Режим контекста" ? "repository" : choices.includes("polling") ? "polling" : "skip";
        expect(choices).toContain(value);
        selected.push(value);
        return value;
      },
      write: () => undefined,
    };
    const env = await runSetupWizard(io, { envPath: path, random: deterministic });
    expect(selected).toEqual(["development", "polling", "repository", "skip"]);
    expect(env.CONTEXT_MODE).toBe("repository");
    expect(env.REPOSITORIES_PATH).toBe("/data/repositories");
    expect(env.PUBLIC_URL).toBeUndefined();
  });

  test("uses defaults and re-prompts invalid non-TTY selections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wizard-"));
    const path = join(directory, ".env");
    const io = fakeIo(["1", "invalid", "", "invalid", "", "", "", "", "", "invalid", "", "", ""]);
    const env = await runSetupWizard(io, { envPath: path, random: deterministic });
    expect(env.NODE_ENV).toBe("development");
    expect(env.TELEGRAM_MODE).toBe("polling");
    expect(io.output.join("\n")).toContain("Выберите один из вариантов");
  });
});
