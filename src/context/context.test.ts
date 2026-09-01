import { describe, expect, test } from "bun:test";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { ProjectContextService } from "./service";
import { ProjectContextStorage } from "./storage";
import { collectProjectSources, collectRepositoryDocs, type ProjectSources } from "./source-collector";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectComponents } from "./component-scorer";

const profile = { productSummary: "Shop", communityAssumption: "Reports are from users", components: [
  { id: "checkout", description: "Payment checkout", aliases: ["payment"], indicators: ["card fails"], likelyLabels: ["bug"] },
  { id: "catalog", description: "Product list", aliases: ["products"], indicators: ["missing item"], likelyLabels: ["bug"] },
], externalPlatforms: [], terminology: {}, disambiguationRules: ["Do not invent causes"] };

describe("project context", () => {
  test("caches matching fingerprints and regenerates changed sources", async () => {
    const database = openDatabase(":memory:"); migrate(database);
    database.exec("INSERT INTO git_connections (id, provider) VALUES ('c', 'github'); INSERT INTO repositories (id, git_connection_id, provider_repository_id, full_name) VALUES ('r', 'c', '1', 'a/r')");
    let calls = 0;
    const service = new ProjectContextService(new ProjectContextStorage(database), { generateProjectContext: async () => { calls++; return profile; } });
    const sources: ProjectSources = { description: "one", labels: [], tree: [], files: {}, recentIssues: [], docs: [] };
    await service.refresh("r", sources); await service.refresh("r", sources); await service.refresh("r", { ...sources, description: "two" });
    expect(calls).toBe(2);
    expect(new ProjectContextStorage(database).get("r")?.generatedAt).toBeString();
  });

  test("collects bounded provider sources without remote documentation", async () => {
    const provider = { listLabels: async () => Array.from({ length: 120 }, (_, index) => ({ name: `l${index}`, color: "", description: null })), collectProjectSources: async () => ({ tree: Array.from({ length: 300 }, (_, index) => `${index}`), files: {}, recentIssues: Array.from({ length: 60 }, (_, index) => ({ title: `${index}`, labels: [] })) }) } as any;
    const sources = await collectProjectSources(provider, { id: "1", owner: "a", name: "r", fullName: "a/r", description: "d", private: false, webUrl: "", defaultBranch: "main" });
    expect(sources.labels).toHaveLength(100); expect(sources.tree).toHaveLength(250); expect(sources.recentIssues).toHaveLength(50); expect(sources.docs).toEqual([]);
  });

  test("collects bounded allow-listed docs from the checkout only", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "repository-docs-"));
    await mkdir(join(checkout, "docs", "nested"), { recursive: true });
    await writeFile(join(checkout, "docs", "overview.md"), "VLESS subscription sales");
    await writeFile(join(checkout, "docs", "nested", "access.txt"), "access management");
    await writeFile(join(checkout, "README.md"), "must not be collected");
    await writeFile(join(checkout, "docs", "image.png"), "must not be collected");
    expect(await collectRepositoryDocs(checkout)).toEqual([
      { sourceId: "docs/nested/access.txt", text: "access management" },
      { sourceId: "docs/overview.md", text: "VLESS subscription sales" },
    ]);
  });

  test("selects top components only for a clear local score", () => {
    expect(selectComponents(profile, "payment card fails").map((item) => item.id)).toContain("checkout");
    expect(selectComponents(profile, "unknown report")).toHaveLength(2);
  });
});
