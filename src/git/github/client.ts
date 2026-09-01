import { GitProviderError, type FetchFn, type TokenProvider } from "../types";

const GITHUB_API_URL = "https://api.github.com";

export type GitHubClientOptions = {
  token: TokenProvider;
  fetch?: FetchFn;
  timeoutMs?: number;
};

export class GitHubClient {
  private readonly fetch: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  request(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.requestJson(path, init);
  }

  async requestText(path: string, init: RequestInit = {}): Promise<string> {
    return (await this.requestResponse(path, init)).text();
  }

  async requestPage(path: string, init: RequestInit = {}): Promise<{ data: unknown; link: string | null }> {
    const response = await this.requestResponse(path, init);
    try {
      return { data: await response.json(), link: response.headers.get("link") };
    } catch (error) {
      throw new GitProviderError("invalid_response", "GitHub returned an invalid JSON response", undefined, { cause: error });
    }
  }

  token(): Promise<string> { return Promise.resolve(this.options.token()); }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.requestResponse(path, init);
    try {
      return await response.json();
    } catch (error) {
      throw new GitProviderError("invalid_response", "GitHub returned an invalid JSON response", undefined, { cause: error });
    }
  }

  private async requestResponse(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token = await this.options.token();
      const response = await this.fetch(`${GITHUB_API_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });
      if (!response.ok) throw await responseError(response, "GitHub");
      return response;
    } catch (error) {
      if (error instanceof GitProviderError) throw error;
      if (controller.signal.aborted) throw new GitProviderError("timeout", "GitHub request timed out", undefined, { cause: error });
      throw new GitProviderError("network", "GitHub request failed", undefined, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function responseError(response: Response, provider: string): Promise<GitProviderError> {
  const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : "api";
  return new GitProviderError(code, `${provider} API request failed with status ${response.status}`, response.status);
}
