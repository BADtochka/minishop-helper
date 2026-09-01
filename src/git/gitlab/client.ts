import { GitProviderError, type FetchFn, type TokenProvider } from "../types";

export type GitLabClientOptions = {
  baseUrl: string;
  token: TokenProvider;
  fetch?: FetchFn;
  timeoutMs?: number;
  refreshToken?: () => Promise<string>;
};

export class GitLabClient {
  private readonly fetch: FetchFn;
  private readonly timeoutMs: number;
  private readonly apiUrl: string;

  constructor(private readonly options: GitLabClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.apiUrl = `${options.baseUrl.replace(/\/$/, "")}/api/v4`;
  }

  async cloneTarget(path: string): Promise<{ url: string; token: string }> {
    return { url: new URL(`${path}.git`, `${this.options.baseUrl.replace(/\/$/, "")}/`).toString(), token: await this.options.token() };
  }

  request(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.requestJson(path, init);
  }

  async requestText(path: string, init: RequestInit = {}, maxBytes = 64 * 1024): Promise<string> {
    return readBoundedText(await this.requestResponse(path, init), maxBytes);
  }

  async requestPage(path: string, init: RequestInit = {}): Promise<{ data: unknown; nextPage: string | null }> {
    const response = await this.requestResponse(path, init);
    try {
      return { data: await response.json(), nextPage: response.headers.get("x-next-page") || null };
    } catch (error) {
      throw new GitProviderError("invalid_response", "GitLab returned an invalid JSON response", undefined, { cause: error });
    }
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.requestResponse(path, init);
    try {
      return await response.json();
    } catch (error) {
      throw new GitProviderError("invalid_response", "GitLab returned an invalid JSON response", undefined, { cause: error });
    }
  }

  private async requestResponse(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let token = await this.options.token();
      let response = await this.fetch(`${this.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
      if (response.status === 401 && this.options.refreshToken) {
        token = await this.options.refreshToken();
        response = await this.fetch(`${this.apiUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
        });
      }
      if (!response.ok) throw responseError(response);
      return response;
    } catch (error) {
      if (error instanceof GitProviderError) throw error;
      if (controller.signal.aborted) throw new GitProviderError("timeout", "GitLab request timed out", undefined, { cause: error });
      throw new GitProviderError("network", "GitLab request failed", undefined, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new GitProviderError("invalid_response", "GitLab response exceeds source size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new GitProviderError("invalid_response", "GitLab response exceeds source size limit"); }
    text += decoder.decode(value, { stream: true });
  }
}

function responseError(response: Response): GitProviderError {
  const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : "api";
  return new GitProviderError(code, `GitLab API request failed with status ${response.status}`, response.status);
}
