import type { AppDatabase } from "../storage/db";
import { IssueSchema, type Issue } from "../codex/schemas";
import type { GenerationUsage } from "../jobs/process-issue";
import type { ImageAttachment } from "../jobs/process-issue";
import { escapeRichMarkdown } from "./rich-message";

export type StoredPreview = { requestId: string; issue: Issue; usage?: GenerationUsage; images?: ImageAttachment[]; imageMessageIds?: number[]; status: string; chatId: string; messageThreadId?: number; sourceMessageId?: number; previewMessageId?: number; createdBy?: number };
export type PurgedIssueDraft = StoredPreview & { incomingMessageId?: number };
type Row = { request_id: string; issue_json: string; usage_json: string | null; images_json: string | null; image_message_ids_json: string | null; status: string; chat_id: string; message_thread_id: number | null; source_message_id: number | null; preview_message_id: number | null; created_by: number | null };
export class PreviewRepository {
  constructor(private readonly database: AppDatabase) {}
  create(preview: Omit<StoredPreview, "status">): void {
    this.database.query("INSERT INTO issue_previews (request_id, issue_json, usage_json, images_json, chat_id, message_thread_id, source_message_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(preview.requestId, JSON.stringify(IssueSchema.parse(preview.issue)), preview.usage ? JSON.stringify(preview.usage) : null, preview.images?.length ? JSON.stringify(preview.images) : null, preview.chatId, preview.messageThreadId ?? null, preview.sourceMessageId ?? null, preview.createdBy ?? null);
    this.database.query("UPDATE requests SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(preview.requestId);
  }
  setMessage(requestId: string, messageId: number): void { this.database.query("UPDATE issue_previews SET preview_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?").run(messageId, requestId); }
  setImageMessages(requestId: string, messageIds: number[]): void { this.database.query("UPDATE issue_previews SET image_message_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?").run(messageIds.length ? JSON.stringify(messageIds) : null, requestId); }
  replacePresentation(requestId: string, expectedMessageId: number | undefined, messageId: number, imageMessageIds: number[]): boolean {
    return this.database.query("UPDATE issue_previews SET preview_message_id = ?, image_message_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND preview_message_id IS ?")
      .run(messageId, imageMessageIds.length ? JSON.stringify(imageMessageIds) : null, requestId, expectedMessageId ?? null).changes === 1;
  }
  get(requestId: string): StoredPreview | undefined { const row = this.database.query<Row, [string]>("SELECT request_id, issue_json, usage_json, images_json, image_message_ids_json, status, chat_id, message_thread_id, source_message_id, preview_message_id, created_by FROM issue_previews WHERE request_id = ?").get(requestId); return row ? map(row) : undefined; }
  transition(requestId: string, from: string, to: string): boolean {
    return this.database.transaction(() => {
      const changed = this.database.query("UPDATE issue_previews SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = ?").run(to, requestId, from).changes === 1;
      if (changed) this.database.query("UPDATE requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(to, requestId);
      return changed;
    })();
  }
  purgeDraft(requestId: string): PurgedIssueDraft | undefined {
    return this.database.transaction(() => {
      const preview = this.get(requestId);
      if (!preview || preview.status !== "pending_confirmation") return undefined;
      const request = this.database.query<{ request_data: string }, [string]>("SELECT request_data FROM requests WHERE id = ?").get(requestId);
      if (!request) return undefined;
      let incomingMessageId: number | undefined;
      try {
        const data = JSON.parse(request.request_data) as { incomingMessageId?: unknown };
        if (typeof data.incomingMessageId === "number") incomingMessageId = data.incomingMessageId;
      } catch { /* Purging must not retain a draft because its metadata is malformed. */ }
      this.database.query("DELETE FROM issue_previews WHERE request_id = ? AND status = 'pending_confirmation'").run(requestId);
      this.database.query("DELETE FROM jobs WHERE request_id = ?").run(requestId);
      const deleted = this.database.query("DELETE FROM requests WHERE id = ?").run(requestId).changes;
      if (deleted !== 1) throw new Error("Issue draft request changed while purging");
      return { ...preview, incomingMessageId };
    })();
  }
  recreate(requestId: string): boolean {
    return this.database.transaction(() => {
      // A running generation or Issue creation owns its state and must not be
      // interrupted by a recovery callback.
      const changed = this.database.query(`
        UPDATE issue_previews SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND (
          status IN ('pending_confirmation', 'clarification_requested', 'completed', 'failed', 'needs_recovery')
          OR status = 'regenerating' AND NOT EXISTS (
            SELECT 1 FROM jobs WHERE request_id = ? AND status IN ('queued', 'running')
          )
        )
      `).run(requestId, requestId).changes === 1;
      if (changed) this.database.query("UPDATE requests SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
      return changed;
    })();
  }
  findClarification(chatId: string, _threadId: number | undefined, replyToMessageId: number): StoredPreview | undefined {
    const row = this.database.query<Row, [string, number, number]>(`SELECT request_id, issue_json, usage_json, images_json, image_message_ids_json, status, chat_id, message_thread_id, source_message_id, preview_message_id, created_by FROM issue_previews
      WHERE chat_id = ? AND status = 'clarification_requested' AND (source_message_id = ? OR preview_message_id = ?) LIMIT 1`)
      .get(chatId, replyToMessageId, replyToMessageId);
    return row ? map(row) : undefined;
  }
  findByReply(chatId: string, replyToMessageId: number): StoredPreview | undefined {
    const row = this.database.query<Row, [string, number, number]>(`SELECT request_id, issue_json, usage_json, images_json, image_message_ids_json, status, chat_id, message_thread_id, source_message_id, preview_message_id, created_by FROM issue_previews
      WHERE chat_id = ? AND (source_message_id = ? OR preview_message_id = ?) ORDER BY updated_at DESC LIMIT 1`)
      .get(chatId, replyToMessageId, replyToMessageId);
    return row ? map(row) : undefined;
  }
  findBySource(chatId: string, threadId: number | undefined, sourceMessageId: number): StoredPreview | undefined {
    const row = this.database.query<Row, [string, number | null, number]>(`SELECT request_id, issue_json, usage_json, images_json, image_message_ids_json, status, chat_id, message_thread_id, source_message_id, preview_message_id, created_by FROM issue_previews
      WHERE chat_id = ? AND message_thread_id IS ? AND source_message_id = ? LIMIT 1`)
      .get(chatId, threadId ?? null, sourceMessageId);
    return row ? map(row) : undefined;
  }
  updateGenerated(requestId: string, issue: Issue, usage?: GenerationUsage, images?: ImageAttachment[]): boolean {
    return this.database.transaction(() => {
      const changed = this.database.query("UPDATE issue_previews SET issue_json = ?, usage_json = ?, images_json = ?, status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'regenerating'")
        .run(JSON.stringify(IssueSchema.parse(issue)), usage ? JSON.stringify(usage) : null, images?.length ? JSON.stringify(images) : null, requestId).changes === 1;
      if (changed) this.database.query("UPDATE requests SET status = 'pending_confirmation', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
      return changed;
    })();
  }
}
function map(row: Row): StoredPreview { return { requestId: row.request_id, issue: IssueSchema.parse(JSON.parse(row.issue_json)), usage: row.usage_json ? JSON.parse(row.usage_json) as GenerationUsage : undefined, images: row.images_json ? JSON.parse(row.images_json) as ImageAttachment[] : undefined, imageMessageIds: row.image_message_ids_json ? JSON.parse(row.image_message_ids_json) as number[] : undefined, status: row.status, chatId: row.chat_id, messageThreadId: row.message_thread_id ?? undefined, sourceMessageId: row.source_message_id ?? undefined, previewMessageId: row.preview_message_id ?? undefined, createdBy: row.created_by ?? undefined }; }
export function previewText(preview: StoredPreview): string {
  const issue = preview.issue;
  const labels = issue.labels.length ? issue.labels.map(escapeRichMarkdown).join(", ") : "нет";
  const usage = preview.usage
    ? `<footer>Токены: ${preview.usage.totalTokens} (вход: ${preview.usage.inputTokens ?? "?"}, выход: ${preview.usage.outputTokens ?? "?"})\nПримерная стоимость: ${preview.usage.estimatedCostUsd === undefined ? "недоступна" : `~$${preview.usage.estimatedCostUsd.toFixed(4)}`}</footer>`
    : "<footer>Токены: недоступны\nПримерная стоимость: недоступна</footer>";
  const header = `# ${escapeRichMarkdown(issue.title)}\n\n**Тип:** ${escapeRichMarkdown(issue.type)}\n**Метки:** ${labels}\n**Confidence:** ${Math.round(issue.confidence * 100)}%\n\n---\n\n`;
  const footer = `\n\n---\n\n${usage}`;
  const available = 4096 - header.length - footer.length - 45;
  const description = issue.description.length > available
    ? `${issue.description.slice(0, Math.max(0, available))}\n\n_(Описание сокращено в предпросмотре)_`
    : issue.description;
  return `${header}${description}${footer}`;
}

export function isTelegramMessageNotFound(error: unknown): boolean {
  const candidate = error && typeof error === "object" ? error as { description?: unknown; message?: unknown } : undefined;
  const message = [candidate?.description, candidate?.message, error instanceof Error ? error.message : undefined]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return message.includes("message not found") || message.includes("message to edit not found");
}
