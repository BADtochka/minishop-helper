import type { AppDatabase } from "../storage/db";
import { ProjectContextSchema, serializeProjectContext, type ProjectContext } from "./schema";

export class ProjectContextStorage {
  constructor(private readonly database: AppDatabase) {}
  get(repositoryId: string): { context: ProjectContext; fingerprint: string; generatedAt: string } | undefined {
    const row = this.database.query<{ project_context_json: string; project_context_fingerprint: string; project_context_generated_at: string }, [string]>("SELECT project_context_json, project_context_fingerprint, project_context_generated_at FROM repositories WHERE id = ? AND project_context_json IS NOT NULL").get(repositoryId);
    return row ? { context: ProjectContextSchema.parse(JSON.parse(row.project_context_json)), fingerprint: row.project_context_fingerprint, generatedAt: row.project_context_generated_at } : undefined;
  }
  save(repositoryId: string, context: ProjectContext, fingerprint: string): void {
    this.database.query("UPDATE repositories SET project_context_json = ?, project_context_fingerprint = ?, project_context_generated_at = CURRENT_TIMESTAMP WHERE id = ?").run(serializeProjectContext(context), fingerprint, repositoryId);
  }
}
