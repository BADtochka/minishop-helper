import type { GitProjectSources, GitProvider } from "../provider";
import { GitProviderError, type CreatedIssue, type CreateIssueAttachment, type CreateIssueInput, type GitLabel, type GitRepository, type GitUser } from "../types";
import { GitLabClient } from "./client";
import { z } from "zod";

export class GitLabProvider implements GitProvider {
  constructor(private readonly client: GitLabClient) {}

  async getCurrentUser(): Promise<GitUser> {
    const user = GitLabUserSchema.parse(await this.client.request("/user"));
    return { id: String(user.id), login: user.username, name: user.name, avatarUrl: user.avatar_url };
  }

  async listRepositories(): Promise<GitRepository[]> {
    const projects: GitRepository[] = [];
    let page = "1";
    do {
      const result = await this.client.requestPage(`/projects?membership=true&per_page=100&page=${page}`);
      projects.push(...z.array(GitLabProjectSchema).parse(result.data).map(toRepository));
      page = result.nextPage ?? "";
    } while (page);
    return projects;
  }

  async getRepository(repository: GitRepository): Promise<GitRepository> {
    return toRepository(GitLabProjectSchema.parse(await this.client.request(`/projects/${encode(repository.id)}`)));
  }

  async listBranches(repository: GitRepository): Promise<string[]> {
    const branches: string[] = [];
    let page = "1";
    do {
      const result = await this.client.requestPage(`/projects/${encode(repository.id)}/repository/branches?per_page=100&page=${page}`);
      branches.push(...z.array(GitLabBranchSchema).parse(result.data).map((branch) => branch.name));
      page = result.nextPage ?? "";
    } while (page);
    return branches;
  }

  async listLabels(repository: GitRepository): Promise<GitLabel[]> {
    const labels = z.array(GitLabLabelSchema).parse(await this.client.request(`/projects/${encode(repository.id)}/labels?per_page=100`));
    return labels.map((label) => ({ name: label.name, color: label.color.replace(/^#/, ""), description: label.description }));
  }

  async createIssue(repository: GitRepository, input: CreateIssueInput): Promise<CreatedIssue> {
    const attachments = await this.uploadAttachments(repository, input.attachments);
    const issue = GitLabIssueSchema.parse(await this.client.request(`/projects/${encode(repository.id)}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, ...(input.description === undefined && !attachments.length ? {} : { description: [input.description, ...attachments].filter(Boolean).join("\n\n") }), ...(input.labels === undefined ? {} : { labels: input.labels.join(",") }) }),
    }));
    return { id: String(issue.id), number: issue.iid, title: issue.title, webUrl: issue.web_url };
  }

  private async uploadAttachments(repository: GitRepository, attachments: readonly CreateIssueAttachment[] | undefined): Promise<string[]> {
    if (!attachments?.length) return [];
    if (attachments.length > 10) throw new GitProviderError("api", "Too many issue attachments");
    const markdown: string[] = [];
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index]!;
      if (!SUPPORTED_IMAGE_TYPES.has(attachment.mimeType)) throw new GitProviderError("api", "Unsupported issue attachment type");
      const bytes = decodeAttachment(attachment);
      const form = new FormData();
      form.append("file", new File([bytes], safeFilename(attachment.filename, attachment.mimeType, index), { type: attachment.mimeType }));
      const upload = GitLabUploadSchema.parse(await this.client.request(`/projects/${encode(repository.id)}/uploads`, { method: "POST", body: form }));
      markdown.push(upload.markdown);
    }
    return markdown;
  }

  async findIssueByMarker(repository: GitRepository, marker: string): Promise<CreatedIssue | undefined> {
    const issues = z.array(GitLabIssueSchema).parse(await this.client.request(`/projects/${encode(repository.id)}/issues?scope=all&search=${encodeURIComponent(marker)}&in=description&per_page=1`));
    const issue = issues[0];
    return issue ? { id: String(issue.id), number: issue.iid, title: issue.title, webUrl: issue.web_url } : undefined;
  }

  async getCloneTarget(repository: GitRepository) {
    const target = await this.client.cloneTarget(repository.fullName);
    const origin = new URL(target.url).origin;
    return {
      url: target.url,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: Bearer ${target.token}` },
    };
  }


  async collectProjectSources(repository: GitRepository): Promise<GitProjectSources> {
    const base = `/projects/${encode(repository.id)}`;
    const branch = repository.defaultBranch ?? "HEAD";
    const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
    const tree: string[] = [];
    const candidates = new Set<string>();
    let requests = 0;
    while (queue.length && requests < 20 && tree.length < 250) {
      const current = queue.shift()!;
      const path = current.path ? `&path=${encodeURIComponent(current.path)}` : "";
      const entries = z.array(GitLabTreeEntrySchema).parse(await this.client.request(`${base}/repository/tree?ref=${encodeURIComponent(branch)}&per_page=100${path}`));
      requests++;
      for (const entry of entries) {
        if (tree.length >= 250) break;
        tree.push(entry.path);
        if (entry.type === "tree" && current.depth < 2 && (current.depth === 0 || entry.path.toLowerCase().startsWith("docs"))) queue.push({ path: entry.path, depth: current.depth + 1 });
        if (entry.type === "blob" && isContextFile(entry.path)) candidates.add(entry.path);
      }
    }
    const files: Record<string, string> = {};
    let total = 0;
    for (const path of [...candidates].slice(0, 20)) {
      const text = await this.client.requestText(`${base}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`);
      const bounded = text.slice(0, Math.min(32_000, 128_000 - total));
      if (!bounded) break;
      files[path] = bounded;
      total += Buffer.byteLength(bounded);
      if (total >= 128_000) break;
    }
    const issues = z.array(GitLabRecentIssueSchema).parse(await this.client.request(`${base}/issues?scope=all&order_by=created_at&sort=desc&per_page=50`));
    return { tree, files, recentIssues: issues.slice(0, 50).map((issue) => ({ title: issue.title, labels: issue.labels })) };
  }
}

const GitLabUserSchema = z.object({ id: z.number(), username: z.string(), name: z.string().nullable(), avatar_url: z.string().url().nullable() });
const GitLabProjectSchema = z.object({ id: z.number(), name: z.string(), path_with_namespace: z.string(), description: z.string().nullable(), visibility: z.string(), web_url: z.string().url(), default_branch: z.string().nullable().optional(), namespace: z.object({ full_path: z.string() }) });
const GitLabLabelSchema = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });
const GitLabBranchSchema = z.object({ name: z.string().min(1).max(256) });
const GitLabIssueSchema = z.object({ id: z.number(), iid: z.number().int(), title: z.string(), web_url: z.string().url() });
const GitLabUploadSchema = z.object({ markdown: z.string().min(1) });
const GitLabTreeEntrySchema = z.object({ path: z.string(), type: z.enum(["tree", "blob"]) });
const GitLabRecentIssueSchema = z.object({ title: z.string(), labels: z.array(z.string()) });
type GitLabProject = z.infer<typeof GitLabProjectSchema>;

function toRepository(project: GitLabProject): GitRepository {
  return { id: String(project.id), owner: project.namespace.full_path, name: project.name, fullName: project.path_with_namespace, description: project.description, private: project.visibility === "private", webUrl: project.web_url, defaultBranch: project.default_branch ?? null };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function decodeAttachment(attachment: CreateIssueAttachment): ArrayBuffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataBase64) || attachment.dataBase64.length % 4 !== 0) throw new GitProviderError("api", "Invalid issue attachment data");
  const bytes = Buffer.from(attachment.dataBase64, "base64");
  if (!bytes.length || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new GitProviderError("api", "Issue attachment exceeds size limit");
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function safeFilename(filename: string | undefined, mimeType: string, index: number): string {
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const cleaned = filename?.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || `telegram-image-${index + 1}.${extension}`;
}

function isContextFile(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1)!;
  return /^readme(?:\.[^.]+)?$/.test(name)
    || /^docs\/(?:index|readme)(?:\.[^.]+)?$/.test(lower)
    || ["package.json", "composer.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "docker-compose.yml", "compose.yml"].includes(name);
}
