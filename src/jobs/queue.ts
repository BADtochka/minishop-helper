import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../storage/db";
import type { CreatedIssue } from "../git/types";

export type QueueRequest<T = unknown> = {
  id: string;
  chatId: string;
  data: T;
  status: string;
  messageThreadId?: number;
  sourceMessageId?: number;
};

export type QueueJob<T = unknown> = {
  id: string;
  requestId: string;
  data: T;
  status: string;
  attempts: number;
  lockedAt: string | null;
};

export type ClaimedJob<RequestData = unknown, JobData = unknown> = {
  job: QueueJob<JobData>;
  request: QueueRequest<RequestData>;
};

type RequestRow = { id: string; chat_id: string; request_data: string; status: string; message_thread_id: number | null; source_message_id: number | null };
type JobRow = { id: string; request_id: string; job_data: string; status: string; attempts: number; locked_at: string | null };

export type EnqueueInput<RequestData, JobData> = {
  updateId: number;
  chatId: string;
  messageThreadId?: number;
  sourceMessageId?: number;
  requestData: RequestData;
  jobData: JobData;
};

export type EnqueueResult = { duplicate: true } | { duplicate: false; requestId: string; jobId: string };

export class JobQueue {
  static readonly MAX_ATTEMPTS = 4;
  constructor(private readonly database: AppDatabase) {}
  getDatabase(): AppDatabase { return this.database; }

  enqueue<RequestData, JobData>(input: EnqueueInput<RequestData, JobData>): EnqueueResult {
    return this.database.transaction((): EnqueueResult => {
      const inserted = this.database.query("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)").run(input.updateId);
      if (inserted.changes === 0) return { duplicate: true };

      const requestId = randomUUID();
      const jobId = randomUUID();
      this.database.query("INSERT INTO requests (id, chat_id, status, request_data, message_thread_id, source_message_id) VALUES (?, ?, 'queued', ?, ?, ?)")
        .run(requestId, input.chatId, JSON.stringify(input.requestData), input.messageThreadId ?? null, input.sourceMessageId ?? null);
      this.database.query("INSERT INTO jobs (id, request_id, status, job_data) VALUES (?, ?, 'queued', ?)")
        .run(jobId, requestId, JSON.stringify(input.jobData));
      return { duplicate: false, requestId, jobId };
    })();
  }

  enqueueClarification<JobData>(updateId: number, requestId: string, jobData: JobData): boolean {
    return this.database.transaction(() => {
      if (this.database.query("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)").run(updateId).changes === 0) return false;
      const changed = this.database.query("UPDATE issue_previews SET status = 'regenerating', updated_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'clarification_requested'").run(requestId).changes;
      if (changed !== 1) return false;
      this.database.query("UPDATE requests SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
      this.database.query("INSERT INTO jobs (id, request_id, status, job_data) VALUES (?, ?, 'queued', ?)").run(randomUUID(), requestId, JSON.stringify(jobData));
      return true;
    })();
  }

  claimNext<RequestData, JobData>(now = new Date()): ClaimedJob<RequestData, JobData> | undefined {
    const lockedAt = now.toISOString();
    const job = this.database.query<JobRow, [string]>(`
      UPDATE jobs
      SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'queued' AND run_after <= CURRENT_TIMESTAMP
        ORDER BY run_after, created_at
        LIMIT 1
      ) AND status = 'queued'
      RETURNING id, request_id, job_data, status, attempts, locked_at
    `).get(lockedAt);
    if (!job) return undefined;

    const request = this.database.query<RequestRow, [string]>(
      "SELECT id, chat_id, request_data, status, message_thread_id, source_message_id FROM requests WHERE id = ?",
    ).get(job.request_id);
    if (!request) throw new Error(`Job ${job.id} references a missing request`);
    return { job: readJob<JobData>(job), request: readRequest<RequestData>(request) };
  }

  recoverStaleLocks(now = new Date(), maxAgeMs = 15 * 60 * 1000): number {
    const staleBefore = new Date(now.getTime() - maxAgeMs).toISOString();
    return this.database.transaction(() => {
      const uncertain = this.database.query(`
        UPDATE jobs
        SET status = 'needs_recovery', recovery_reason = 'stale_lock_after_provider_start', error = 'provider result requires reconciliation', locked_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND locked_at < ? AND provider_started_at IS NOT NULL
      `).run(staleBefore);
      const safe = this.database.query(`
        UPDATE jobs
        SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
          error = 'stale_lock_before_provider_start', locked_at = NULL, run_after = ?, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND locked_at < ? AND provider_started_at IS NULL
      `).run(JobQueue.MAX_ATTEMPTS, sqliteDate(now), staleBefore);
      if (uncertain.changes > 0 || safe.changes > 0) {
        this.database.query(`
          UPDATE requests SET status = (SELECT status FROM jobs WHERE jobs.request_id = requests.id), updated_at = CURRENT_TIMESTAMP
          WHERE id IN (SELECT request_id FROM jobs WHERE status IN ('failed', 'needs_recovery'))
        `).run();
      }
      return uncertain.changes + safe.changes;
    })();
  }

  hasActiveJob(requestId: string, now = new Date(), maxLockAgeMs = 15 * 60 * 1000): boolean {
    this.recoverStaleLocks(now, maxLockAgeMs);
    return Boolean(this.database.query<{ active: number }, [string]>(
      "SELECT 1 AS active FROM jobs WHERE request_id = ? AND status IN ('queued', 'running') LIMIT 1",
    ).get(requestId));
  }

  markProviderStarted(jobId: string, now = new Date()): void {
    const changed = this.database.query("UPDATE jobs SET provider_started_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'")
      .run(now.toISOString(), jobId).changes;
    if (changed !== 1) throw new Error(`Job ${jobId} is not running`);
  }

  retry(jobId: string, error: unknown, reconciliationAvailable: boolean, now = new Date()): "queued" | "failed" | "needs_recovery" {
    const message = error instanceof Error ? error.message : String(error);
    return this.database.transaction(() => {
      const job = this.database.query<{ request_id: string; attempts: number; provider_started_at: string | null }, [string]>("SELECT request_id, attempts, provider_started_at FROM jobs WHERE id = ? AND status = 'running'").get(jobId);
      if (!job) throw new Error(`Job ${jobId} is not running`);
      const status = job.provider_started_at && !reconciliationAvailable ? "needs_recovery" : job.attempts >= JobQueue.MAX_ATTEMPTS ? "failed" : "queued";
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
      this.database.query("UPDATE jobs SET status = ?, error = ?, recovery_reason = ?, locked_at = NULL, run_after = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, message, status === "needs_recovery" ? "provider_result_unknown" : null, sqliteDate(new Date(now.getTime() + delayMs)), jobId);
      this.database.query("UPDATE requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, job.request_id);
      return status;
    })();
  }

  complete(jobId: string, issue?: CreatedIssue, feedbackMessageId?: number): void {
    this.finish(jobId, "completed", undefined, issue, feedbackMessageId);
  }

  completePreview(jobId: string): void {
    this.database.query("UPDATE jobs SET status = 'completed', locked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'").run(jobId);
  }

  fail(jobId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.finish(jobId, "failed", message);
  }

  private finish(jobId: string, status: "completed" | "failed", error?: string, issue?: CreatedIssue, feedbackMessageId?: number): void {
    this.database.transaction(() => {
      const job = this.database.query<{ request_id: string }, [string]>("SELECT request_id FROM jobs WHERE id = ? AND status = 'running'").get(jobId);
      if (!job) throw new Error(`Job ${jobId} is not running`);
      this.database.query("UPDATE jobs SET status = ?, error = ?, locked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, error ?? null, jobId);
      this.database.query(`
        UPDATE requests SET status = ?, issue_id = ?, issue_number = ?, issue_title = ?, issue_url = ?,
          feedback_message_id = COALESCE(?, feedback_message_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(status, issue?.id ?? null, issue?.number ?? null, issue?.title ?? null, issue?.webUrl ?? null, feedbackMessageId ?? null, job.request_id);
    })();
  }
}

function readRequest<T>(row: RequestRow): QueueRequest<T> {
  return { id: row.id, chatId: row.chat_id, status: row.status, data: JSON.parse(row.request_data) as T, messageThreadId: row.message_thread_id ?? undefined, sourceMessageId: row.source_message_id ?? undefined };
}

function readJob<T>(row: JobRow): QueueJob<T> {
  return { id: row.id, requestId: row.request_id, status: row.status, attempts: row.attempts, lockedAt: row.locked_at, data: JSON.parse(row.job_data) as T };
}

function sqliteDate(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}
