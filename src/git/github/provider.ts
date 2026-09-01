import type { GitProjectSources, GitProvider } from "../provider";
import type { CreatedIssue, CreateIssueInput, GitLabel, GitRepository, GitUser } from "../types";
import { GitHubClient } from "./client";
import { z } from "zod";

export class GitHubProvider implements GitProvider {
  constructor(private readonly client: GitHubClient) {}

  async getCurrentUser(): Promise<GitUser> {
    const user = GitHubUserSchema.parse(await this.client.request("/user"));
    return { id: String(user.id), login: user.login, name: user.name, avatarUrl: user.avatar_url };
  }

  async listRepositories(): Promise<GitRepository[]> {
    const repositories: GitRepository[] = [];
    let path: string | null = "/installation/repositories?per_page=100";
    while (path) {
      const page = await this.client.requestPage(path);
      repositories.push(...GitHubRepositoryPageSchema.parse(page.data).repositories.map(toRepository));
      path = nextLink(page.link);
    }
    return repositories;
  }

  async getRepository(repository: GitRepository): Promise<GitRepository> {
    return toRepository(GitHubRepositorySchema.parse(await this.client.request(`/repos/${encode(repository.owner)}/${encode(repository.name)}`)));
  }

  async listBranches(repository: GitRepository): Promise<string[]> {
    const branches: string[] = [];
    let path: string | null = `/repos/${encode(repository.owner)}/${encode(repository.name)}/branches?per_page=100`;
    while (path) {
      const page = await this.client.requestPage(path);
      branches.push(...z.array(GitHubBranchSchema).parse(page.data).map((branch) => branch.name));
      path = nextLink(page.link);
    }
    return branches;
  }

  async listLabels(repository: GitRepository): Promise<GitLabel[]> {
    const labels = z.array(GitHubLabelSchema).parse(await this.client.request(`/repos/${encode(repository.owner)}/${encode(repository.name)}/labels?per_page=100`));
    return labels.map((label) => ({ name: label.name, color: label.color, description: label.description }));
  }

  async createIssue(repository: GitRepository, input: CreateIssueInput): Promise<CreatedIssue> {
    const issue = GitHubIssueSchema.parse(await this.client.request(`/repos/${encode(repository.owner)}/${encode(repository.name)}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, ...(input.description === undefined ? {} : { body: input.description }), ...(input.labels === undefined ? {} : { labels: input.labels }) }),
    }));
    return { id: String(issue.id), number: issue.number, title: issue.title, webUrl: issue.html_url };
  }

  async findIssueByMarker(repository: GitRepository, marker: string): Promise<CreatedIssue | undefined> {
    const query = encodeURIComponent(`repo:${repository.fullName} is:issue ${JSON.stringify(marker)}`);
    const result = z.object({ items: z.array(GitHubIssueSchema) }).parse(await this.client.request(`/search/issues?q=${query}&per_page=1`));
    const issue = result.items[0];
    return issue ? { id: String(issue.id), number: issue.number, title: issue.title, webUrl: issue.html_url } : undefined;
  }

  async getCloneTarget(repository: GitRepository) {
    const token = await this.client.token();
    return {
      url: `https://github.com/${repository.fullName}.git`,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}` },
    };
  }


  async collectProjectSources(repository: GitRepository): Promise<GitProjectSources> {
    const base = `/repos/${encode(repository.owner)}/${encode(repository.name)}`;
    const ref = repository.defaultBranch ? `?ref=${encode(repository.defaultBranch)}` : "";
    const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
    const tree: string[] = [];
    const candidates = new Set<string>();
    let requests = 0;
    while (queue.length && requests < 20 && tree.length < 250) {
      const current = queue.shift()!;
      const suffix = current.path ? `/${current.path}` : "";
      const entries = z.array(GitHubContentSchema).parse(await this.client.request(`${base}/contents${suffix}${ref}`));
      requests++;
      for (const entry of entries.slice(0, 100)) {
        if (tree.length >= 250) break;
        tree.push(entry.path);
        if (entry.type === "dir" && current.depth < 2 && (current.depth === 0 || entry.path.toLowerCase().startsWith("docs"))) queue.push({ path: entry.path, depth: current.depth + 1 });
        if (entry.type === "file" && isContextFile(entry.path) && entry.size <= 64 * 1024) candidates.add(entry.path);
      }
    }
    const files: Record<string, string> = {};
    let total = 0;
    for (const path of [...candidates].slice(0, 20)) {
      const file = GitHubFileSchema.parse(await this.client.request(`${base}/contents/${path.split("/").map(encode).join("/")}${ref}`));
      const text = file.encoding === "base64" ? Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8") : file.content;
      const bounded = text.slice(0, Math.min(32_000, 128_000 - total));
      if (!bounded) break;
      files[path] = bounded;
      total += Buffer.byteLength(bounded);
      if (total >= 128_000) break;
    }
    const issues = z.array(GitHubRecentIssueSchema).parse(await this.client.request(`${base}/issues?state=all&sort=created&direction=desc&per_page=50`));
    return { tree, files, recentIssues: issues.filter((issue) => !issue.pull_request).slice(0, 50).map((issue) => ({ title: issue.title, labels: issue.labels.map((label) => label.name) })) };
  }
}

const GitHubUserSchema = z.object({ id: z.number(), login: z.string(), name: z.string().nullable(), avatar_url: z.string().url().nullable() });
const GitHubRepositorySchema = z.object({ id: z.number(), name: z.string(), full_name: z.string(), description: z.string().nullable(), private: z.boolean(), html_url: z.string().url(), default_branch: z.string().nullable().optional(), owner: z.object({ login: z.string() }) });
const GitHubRepositoryPageSchema = z.object({ repositories: z.array(GitHubRepositorySchema) });
const GitHubLabelSchema = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });
const GitHubBranchSchema = z.object({ name: z.string().min(1).max(256) });
const GitHubIssueSchema = z.object({ id: z.number(), number: z.number().int(), title: z.string(), html_url: z.string().url() });
const GitHubContentSchema = z.object({ path: z.string(), type: z.enum(["file", "dir"]), size: z.number().nonnegative().default(0) });
const GitHubFileSchema = z.object({ content: z.string(), encoding: z.string() });
const GitHubRecentIssueSchema = z.object({ title: z.string(), labels: z.array(z.object({ name: z.string() })), pull_request: z.unknown().optional() });
type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

function toRepository(repository: GitHubRepository): GitRepository {
  return { id: String(repository.id), owner: repository.owner.login, name: repository.name, fullName: repository.full_name, description: repository.description, private: repository.private, webUrl: repository.html_url, defaultBranch: repository.default_branch ?? null };
}

function nextLink(link: string | null): string | null {
  const next = link?.split(",").find((entry) => /rel="next"/.test(entry));
  if (!next) return null;
  const url = next.match(/<([^>]+)>/)?.[1];
  return url ? new URL(url).pathname + new URL(url).search : null;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function isContextFile(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1)!;
  return /^readme(?:\.[^.]+)?$/.test(name)
    || /^docs\/(?:index|readme)(?:\.[^.]+)?$/.test(lower)
    || ["package.json", "composer.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "docker-compose.yml", "compose.yml"].includes(name);
}
