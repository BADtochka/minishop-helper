import { ProjectContextSchema, type ProjectContext } from "./schema";
import { contextFingerprint } from "./fingerprint";
import { ProjectContextStorage } from "./storage";
import type { ProjectSources } from "./source-collector";
import { reportProgress, type ProgressReporter } from "../progress";

export type ProjectContextGenerator = { generateProjectContext(sources: ProjectSources): Promise<unknown> };
export class ProjectContextService {
  constructor(private readonly storage: ProjectContextStorage, private readonly generator: ProjectContextGenerator) {}
  async refresh(repositoryId: string, sources: ProjectSources, force = false, progress?: ProgressReporter): Promise<ProjectContext> {
    const fingerprint = await contextFingerprint(sources);
    const cached = this.storage.get(repositoryId);
    if (!force && cached?.fingerprint === fingerprint) return cached.context;
    await reportProgress(progress, "⏳ Передаю контекст в Codex...");
    const context = ProjectContextSchema.parse(await this.generator.generateProjectContext(sources));
    this.storage.save(repositoryId, context, fingerprint);
    return context;
  }
}
