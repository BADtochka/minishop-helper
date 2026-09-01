export type GitUser = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

export type GitRepository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  webUrl: string;
  defaultBranch: string | null;
};

export type GitLabel = {
  name: string;
  color: string;
  description: string | null;
};

export type CreateIssueInput = {
  title: string;
  description?: string;
  labels?: string[];
  // Providers that support uploads turn these into provider-hosted links in the issue body.
  attachments?: CreateIssueAttachment[];
};

export type CreateIssueAttachment = {
  mimeType: string;
  dataBase64: string;
  filename?: string;
};

export type CreatedIssue = {
  id: string;
  number: number;
  title: string;
  webUrl: string;
};

export type GitProviderErrorCode = "network" | "timeout" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "api" | "invalid_response";

export class GitProviderError extends Error {
  constructor(
    public readonly code: GitProviderErrorCode,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitProviderError";
  }
}

export type TokenProvider = () => string | Promise<string>;
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
