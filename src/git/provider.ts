import type { CreatedIssue, CreateIssueInput, GitLabel, GitRepository, GitUser } from "./types";

export type GitProjectSources = {
  tree: string[];
  files: Record<string, string>;
  recentIssues: Array<{ title: string; labels: string[] }>;
};

export type GitCloneTarget = { url: string; env: Record<string, string> };

export interface GitProvider {
  getCurrentUser(): Promise<GitUser>;
  listRepositories(): Promise<GitRepository[]>;
  getRepository(repository: GitRepository): Promise<GitRepository>;
  listBranches(repository: GitRepository): Promise<string[]>;
  listLabels(repository: GitRepository): Promise<GitLabel[]>;
  createIssue(repository: GitRepository, input: CreateIssueInput): Promise<CreatedIssue>;
  findIssueByMarker?(repository: GitRepository, marker: string): Promise<CreatedIssue | undefined>;
  // Bounded, allow-listed source snippets only; implementations must not clone repositories.
  collectProjectSources?(repository: GitRepository): Promise<GitProjectSources>;
  // Supplies provider-owned URL and ephemeral git authentication without exposing credentials in URLs.
  getCloneTarget?(repository: GitRepository): Promise<GitCloneTarget>;
}
