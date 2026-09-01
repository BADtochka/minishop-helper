import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

export type GitHubInstallation = { accountName: string };

// Kept injectable until GitHub App JWT signing is configured for this deployment.
export interface GitHubAppClient {
  getInstallation(installationId: string): Promise<GitHubInstallation>;
  createInstallationToken(installationId: string): Promise<string>;
}

export class GitHubAppApiClient implements GitHubAppClient {
  constructor(private readonly appId: number, private readonly privateKey: string, private readonly fetch: typeof globalThis.fetch = globalThis.fetch, private readonly timeoutMs = 10_000) {}

  async getInstallation(installationId: string): Promise<GitHubInstallation> {
    const response = await this.request(`/app/installations/${encodeURIComponent(installationId)}`);
    const installation = z.object({ account: z.object({ login: z.string().min(1) }) }).parse(await response.json());
    return { accountName: installation.account.login };
  }

  async createInstallationToken(installationId: string): Promise<string> {
    const response = await this.request(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: "POST" });
    const token = z.object({ token: z.string().min(1) }).parse(await response.json());
    return token.token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetch(`https://api.github.com${path}`, {
      ...init,
      signal,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.appJwt()}`, ...init.headers },
    });
    if (!response.ok) throw new Error(`GitHub App API request failed with status ${response.status}`);
    return response;
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.appId }));
    const input = `${header}.${payload}`;
    const key = createPrivateKey(this.privateKey.replace(/\\n/g, "\n"));
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  }
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
