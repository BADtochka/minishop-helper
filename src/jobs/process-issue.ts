import { IssueSchema, type Issue } from "../codex/schemas";
import type { GitProvider } from "../git/provider";
import type { CreatedIssue, CreateIssueAttachment, GitRepository } from "../git/types";
import type { ProjectContext } from "../context/schema";
import { selectComponents } from "../context/component-scorer";
import { reportProgress, type ProgressReporter } from "../progress";
import { unlink } from "node:fs/promises";

export type ImageAttachment = CreateIssueAttachment;
export type GenerationUsage = { inputTokens?: number; outputTokens?: number; totalTokens: number; estimatedCostUsd?: number; estimated?: boolean };

export type IssueJobData = {
  repositoryId: string;
  repository: GitRepository;
  prompt: string;
  images?: ImageAttachment[];
  projectContext?: ProjectContext;
  clarificationMessageId?: number;
};

export type IssueGenerator = {
  generateIssue(input: { prompt: string; allowedLabels: string[]; cwd?: string; repositoryContext?: string }): Promise<unknown>;
  generateIssueWithUsage?(input: { prompt: string; allowedLabels: string[]; cwd?: string; repositoryContext?: string; images?: Array<{ path: string }> }): Promise<{ issue: unknown; usage?: GenerationUsage }>;
};

export type ProcessIssueDependencies = {
  provider: Pick<GitProvider, "listLabels" | "createIssue"> & Partial<Pick<GitProvider, "findIssueByMarker">>;
  providerForRepository?: (repository: GitRepository, repositoryId: string) => Promise<Pick<GitProvider, "listLabels" | "createIssue"> & Partial<Pick<GitProvider, "findIssueByMarker">>>;
  codex: IssueGenerator;
  beforeProviderCall?: () => void;
  repositoryCheckout?: (job: IssueJobData) => Promise<{ path: string; branch: string; docs: Array<{ sourceId: string; text: string }> }>;
  progress?: ProgressReporter;
};

export async function processIssue(
  requestId: string,
  job: IssueJobData,
  dependencies: ProcessIssueDependencies,
): Promise<CreatedIssue> {
  const provider = await dependencies.providerForRepository?.(job.repository, job.repositoryId) ?? dependencies.provider;
  const availableLabels = (await provider.listLabels(job.repository)).map((label) => label.name);
  const generated = IssueSchema.parse(await dependencies.codex.generateIssue({ prompt: job.prompt, allowedLabels: availableLabels }));
  const issue = normalizeForProvider(generated, availableLabels);
  const marker = `<!-- telegram-request-id: ${requestId} -->`;

  const existing = await provider.findIssueByMarker?.(job.repository, marker);
  if (existing) return existing;
  dependencies.beforeProviderCall?.();

  return provider.createIssue(job.repository, {
    title: issue.title,
    description: `${issue.description}\n\n${marker}`,
    labels: issue.labels,
    attachments: job.images,
  });
}

export async function generateNormalizedIssue(job: IssueJobData, dependencies: ProcessIssueDependencies): Promise<{ issue: Issue; usage?: GenerationUsage }> {
  const provider = await dependencies.providerForRepository?.(job.repository, job.repositoryId) ?? dependencies.provider;
  await reportProgress(dependencies.progress, "⏳ Запрашиваю labels у provider...");
  const labels = (await provider.listLabels(job.repository)).map((label) => label.name);
  const context = job.projectContext;
  const prompt = context ? `${job.prompt}\n\nProject context (advisory; do not invent files or causes):\n${JSON.stringify({ productSummary: context.productSummary, communityAssumption: context.communityAssumption, disambiguationRules: context.disambiguationRules, components: selectComponents(context, job.prompt) })}` : job.prompt;
  await reportProgress(dependencies.progress, "⏳ Обновляю локальную копию...");
  const checkout = await dependencies.repositoryCheckout?.(job);
  await reportProgress(dependencies.progress, "⏳ Передаю задачу в Codex...");
  const input = { prompt, allowedLabels: labels, ...(checkout ? { cwd: checkout.path, repositoryContext: `The configured target repository is checked out read-only in the current working directory on branch ${checkout.branch}. It is authoritative project context. Inspect its docs/ and relevant source files; do not modify files or access the network. Bounded current docs from docs/ follow:\n<repository_docs>\n${JSON.stringify(checkout.docs)}\n</repository_docs>` } : {}) };
  const imagePaths = await materializeImages(job.images);
  try {
    const generated = dependencies.codex.generateIssueWithUsage
      ? await dependencies.codex.generateIssueWithUsage({ ...input, ...(imagePaths.length ? { images: imagePaths.map((path) => ({ path })) } : {}) })
      : { issue: await dependencies.codex.generateIssue(input) };
    const issue = normalizeForProvider(IssueSchema.parse(generated.issue), labels);
    return { issue, usage: generated.usage ?? estimateUsage(prompt, input.repositoryContext, job.images, issue) };
  } finally {
    await Promise.all(imagePaths.map((path) => unlink(path).catch(() => undefined)));
  }
}

// Subscription turns often omit usage. Keep this estimate deterministic and visibly separate from provider metering.
export function estimateUsage(prompt: string, repositoryContext: string | undefined, images: readonly ImageAttachment[] | undefined, issue: Issue): GenerationUsage {
  const inputTokens = Math.ceil((prompt.length + (repositoryContext?.length ?? 0)) / 4) + (images?.length ?? 0) * 765;
  const outputTokens = Math.max(1, Math.ceil(JSON.stringify(issue).length / 4));
  const totalTokens = inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens, estimatedCostUsd: (inputTokens * 2.5 + outputTokens * 15) / 1_000_000, estimated: true };
}

async function materializeImages(images: readonly ImageAttachment[] | undefined): Promise<string[]> {
  if (!images?.length) return [];
  return Promise.all(images.map(async (image) => {
    const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
    const path = `/tmp/minishop-telegram-${crypto.randomUUID()}.${extension}`;
    await Bun.write(path, Buffer.from(image.dataBase64, "base64"));
    return path;
  }));
}

export function normalizeForProvider(issue: Issue, allowedLabels: readonly string[]): Issue {
  const allowed = new Set(allowedLabels);
  const labels = [...new Set(issue.labels.filter((label) => allowed.has(label)))];
  const type = issue.confidence < 0.6 ? "task" : issue.type;
  if (allowed.has(type) && !labels.includes(type)) labels.push(type);
  return { ...issue, type, labels };
}
