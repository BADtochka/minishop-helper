import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../storage/db";
import { migrate } from "../storage/migrations";
import { JobQueue } from "./queue";

describe("JobQueue", () => {
  const database = openDatabase(":memory:");
  const queue = new JobQueue(database);

  afterEach(() => {
    database.exec("DELETE FROM jobs; DELETE FROM requests; DELETE FROM processed_updates;");
  });

  test("enqueues a request and job once per Telegram update", () => {
    migrate(database);
    const input = { updateId: 10, chatId: "42", requestData: { text: "broken" }, jobData: { prompt: "broken" } };

    const first = queue.enqueue(input);
    const second = queue.enqueue(input);

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true });
    expect(database.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  });

  test("claims one queued job atomically and increments attempts", () => {
    migrate(database);
    queue.enqueue({ updateId: 11, chatId: "42", requestData: { text: "broken" }, jobData: { prompt: "broken" } });

    const claimed = queue.claimNext<{ text: string }, { prompt: string }>();

    expect(claimed?.request.data).toEqual({ text: "broken" });
    expect(claimed?.job.data).toEqual({ prompt: "broken" });
    expect(claimed?.job.status).toBe("running");
    expect(claimed?.job.attempts).toBe(1);
    expect(queue.claimNext()).toBeUndefined();
  });

  test("backs off retryable work and quarantines an uncertain stale provider call", () => {
    migrate(database);
    queue.enqueue({ updateId: 12, chatId: "42", requestData: {}, jobData: {} });
    const claimed = queue.claimNext(new Date("2026-01-01T00:00:00.000Z"))!;
    queue.markProviderStarted(claimed.job.id, new Date("2026-01-01T00:00:00.000Z"));
    expect(queue.retry(claimed.job.id, new Error("timeout"), true, new Date("2026-01-01T00:00:00.000Z"))).toBe("queued");
    expect(database.query("SELECT status, run_after FROM jobs").get()).toEqual({ status: "queued", run_after: "2026-01-01 00:00:01" });

    const retried = queue.claimNext(new Date("2026-01-01T00:00:02.000Z"))!;
    expect(queue.recoverStaleLocks(new Date("2026-01-01T00:20:03.000Z"), 15 * 60 * 1000)).toBe(1);
    expect(database.query("SELECT status, recovery_reason FROM jobs WHERE id = ?").get(retried.job.id)).toEqual({ status: "needs_recovery", recovery_reason: "stale_lock_after_provider_start" });
  });

  test("reports activity after recovering locks left by a restart", () => {
    migrate(database);
    const recoverable = queue.enqueue({ updateId: 13, chatId: "42", requestData: {}, jobData: {} });
    if (recoverable.duplicate) throw new Error("unexpected duplicate");
    queue.claimNext(new Date("2026-01-01T00:00:00.000Z"));

    expect(queue.hasActiveJob(recoverable.requestId, new Date("2026-01-01T00:20:00.000Z"))).toBe(true);
    expect(database.query("SELECT status FROM jobs WHERE request_id = ?").get(recoverable.requestId)).toEqual({ status: "queued" });

    database.query("UPDATE jobs SET status = 'running', attempts = 4, locked_at = '2026-01-01T00:00:00.000Z'").run();
    expect(queue.hasActiveJob(recoverable.requestId, new Date("2026-01-01T00:20:00.000Z"))).toBe(false);
    expect(database.query("SELECT status FROM jobs WHERE request_id = ?").get(recoverable.requestId)).toEqual({ status: "failed" });
  });
});
