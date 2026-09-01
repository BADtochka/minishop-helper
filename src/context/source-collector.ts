import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GitProvider } from "../git/provider";
import type { GitRepository } from "../git/types";
import { reportProgress, type ProgressReporter } from "../progress";

export type ProjectSources = {
  description: string | null;
  labels: string[];
  tree: string[];
  files: Record<string, string>;
  recentIssues: Array<{ title: string; labels: string[] }>;
  docs: Array<{ sourceId: string; text: string }>;
};

export async function collectProjectSources(
  provider: GitProvider,
  repository: GitRepository,
  options: { progress?: ProgressReporter } = {},
): Promise<ProjectSources> {
  await reportProgress(options.progress, "⏳ Запрашиваю labels и данные репозитория...");
  const labels = (await provider.listLabels(repository)).slice(0, 100).map((label) => label.name);
  const collected = provider.collectProjectSources
    ? await provider.collectProjectSources(repository)
    : { tree: [], files: {}, recentIssues: [] };
  return {
    description: repository.description?.slice(0, 2_000) ?? null,
    labels,
    tree: collected.tree.slice(0, 250),
    files: collected.files,
    recentIssues: collected.recentIssues.slice(0, 50),
    docs: [],
  };
}

/** Read only regular, text-like files below the checked-out docs directory. */
export async function collectRepositoryDocs(checkoutPath: string): Promise<ProjectSources["docs"]> {
  const docsRoot = join(checkoutPath, "docs");
  const docs: ProjectSources["docs"] = [];
  let total = 0;
  async function visit(directory: string): Promise<void> {
    if (docs.length >= 24 || total >= 128_000) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (docs.length >= 24 || total >= 128_000) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !/\.(md|mdx|txt|rst)$/i.test(entry.name)) continue;
      try {
        const remaining = Math.min(32_000, 128_000 - total);
        const data = await readFile(path);
        if (data.byteLength > remaining || data.includes(0)) continue;
        const text = data.toString("utf8");
        if (!text) continue;
        docs.push({ sourceId: `docs/${relative(docsRoot, path)}`, text });
        total += data.byteLength;
      } catch {
        // A single unreadable documentation file must not block issue generation.
      }
    }
  }
  await visit(docsRoot);
  return docs;
}
