import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { Job, JobPatch, JobSource, NewJob, Outcome, Phase, TranscriptEntry } from "../types.js";
import { assertTransition } from "../workflow/status.js";

interface JobRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  user_id: string;
  source: JobSource;
  event_id: string | null;
  request_text: string;
  followups_json: string;
  phase: Phase;
  understood: string;
  plan_summary: string;
  implementation_summary: string;
  test_summary: string;
  deploy_url: string;
  branch: string;
  worktree_path: string;
  session_id: string;
  error_plain: string;
  progress: string;
  outcome: Outcome | null;
  repair_attempts: number;
  plan_approved: number;
  deploy_approved: number;
  retry_requested: number;
  slack_status_ts: string;
  transcript_json: string;
  ready_at: string;
  created_at: string;
  updated_at: string;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    userId: row.user_id,
    source: row.source,
    eventId: row.event_id ?? undefined,
    requestText: row.request_text,
    followups: JSON.parse(row.followups_json) as string[],
    phase: row.phase,
    understood: row.understood,
    planSummary: row.plan_summary,
    implementationSummary: row.implementation_summary,
    testSummary: row.test_summary,
    deployUrl: row.deploy_url,
    branch: row.branch,
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    errorPlain: row.error_plain,
    progress: row.progress,
    outcome: row.outcome ?? undefined,
    repairAttempts: row.repair_attempts,
    planApproved: row.plan_approved === 1,
    deployApproved: row.deploy_approved === 1,
    retryRequested: row.retry_requested === 1,
    slackStatusTs: row.slack_status_ts,
    transcript: JSON.parse(row.transcript_json) as TranscriptEntry[],
    readyAt: row.ready_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobStore {
  private db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_id TEXT,
        request_text TEXT NOT NULL,
        followups_json TEXT NOT NULL,
        phase TEXT NOT NULL,
        understood TEXT NOT NULL DEFAULT '',
        plan_summary TEXT NOT NULL DEFAULT '',
        implementation_summary TEXT NOT NULL DEFAULT '',
        test_summary TEXT NOT NULL DEFAULT '',
        deploy_url TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        worktree_path TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        error_plain TEXT NOT NULL DEFAULT '',
        progress TEXT NOT NULL DEFAULT '',
        outcome TEXT,
        repair_attempts INTEGER NOT NULL DEFAULT 0,
        plan_approved INTEGER NOT NULL DEFAULT 0,
        deploy_approved INTEGER NOT NULL DEFAULT 0,
        retry_requested INTEGER NOT NULL DEFAULT 0,
        slack_status_ts TEXT NOT NULL DEFAULT '',
        transcript_json TEXT NOT NULL DEFAULT '[]',
        ready_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(channel_id, thread_ts);
      CREATE INDEX IF NOT EXISTS idx_jobs_user_time ON jobs(user_id, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: NewJob, now = new Date()): Job {
    const timestamp = now.toISOString();
    const id = `job_${randomBytes(5).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, channel_id, thread_ts, user_id, source, event_id, request_text, followups_json,
          phase, ready_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.threadTs,
        input.userId,
        input.source,
        input.eventId ?? null,
        input.requestText,
        input.phase,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.must(id);
  }

  reserveEvent(eventId: string, now = new Date()): { reserved: boolean; job?: Job } {
    const existing = this.db.prepare("SELECT job_id FROM slack_events WHERE event_id = ?").get(eventId) as
      | { job_id: string }
      | undefined;
    if (existing) {
      return { reserved: false, job: this.get(existing.job_id) };
    }
    try {
      this.db
        .prepare("INSERT INTO slack_events (event_id, job_id, received_at) VALUES (?, '', ?)")
        .run(eventId, now.toISOString());
      return { reserved: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE/i.test(message)) throw error;
      const raced = this.db.prepare("SELECT job_id FROM slack_events WHERE event_id = ?").get(eventId) as
        | { job_id: string }
        | undefined;
      return { reserved: false, job: raced?.job_id ? this.get(raced.job_id) : undefined };
    }
  }

  attachEvent(eventId: string, jobId: string): void {
    this.db.prepare("UPDATE slack_events SET job_id = ? WHERE event_id = ?").run(jobId, eventId);
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  must(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Missing job ${id}.`);
    return job;
  }

  findByThread(channelId: string, threadTs: string): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT 1")
      .get(channelId, threadTs) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  latestForUser(userId: string): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  countRecentByUser(userId: string, sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id = ? AND created_at >= ?")
      .get(userId, sinceIso) as { count: number };
    return Number(row.count);
  }

  update(id: string, patch: JobPatch, now = new Date()): Job {
    const current = this.must(id);
    if (patch.phase && patch.phase !== current.phase) assertTransition(current.phase, patch.phase);
    const next: Job = {
      ...current,
      ...patch,
      followups: patch.followups ?? current.followups,
      transcript: patch.transcript ?? current.transcript,
      updatedAt: now.toISOString(),
    };
    this.db
      .prepare(
        `UPDATE jobs SET
          request_text = ?, followups_json = ?, phase = ?, understood = ?, plan_summary = ?,
          implementation_summary = ?, test_summary = ?, deploy_url = ?, branch = ?, worktree_path = ?,
          session_id = ?, error_plain = ?, progress = ?, outcome = ?, repair_attempts = ?,
          plan_approved = ?, deploy_approved = ?, retry_requested = ?, slack_status_ts = ?,
          transcript_json = ?, ready_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        next.requestText,
        JSON.stringify(next.followups),
        next.phase,
        next.understood,
        next.planSummary,
        next.implementationSummary,
        next.testSummary,
        next.deployUrl,
        next.branch,
        next.worktreePath,
        next.sessionId,
        next.errorPlain,
        next.progress,
        next.outcome ?? null,
        next.repairAttempts,
        next.planApproved ? 1 : 0,
        next.deployApproved ? 1 : 0,
        next.retryRequested ? 1 : 0,
        next.slackStatusTs,
        JSON.stringify(next.transcript),
        next.readyAt,
        next.updatedAt,
        id,
      );
    return this.must(id);
  }

  listRunnable(): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE phase = 'queued'
            OR phase = 'received'
            OR (phase = 'awaiting_plan_approval' AND plan_approved = 1)
            OR (phase = 'awaiting_deploy_approval' AND deploy_approved = 1)
            OR (phase = 'awaiting_test_decision' AND retry_requested = 1)
         ORDER BY ready_at ASC`,
      )
      .all() as unknown as JobRow[];
    return rows.map((row) => mapJob(row));
  }

  nextRunnable(): Job | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE phase = 'queued'
            OR phase = 'received'
            OR (phase = 'awaiting_plan_approval' AND plan_approved = 1)
            OR (phase = 'awaiting_deploy_approval' AND deploy_approved = 1)
            OR (phase = 'awaiting_test_decision' AND retry_requested = 1)
         ORDER BY
           CASE
             WHEN phase = 'awaiting_deploy_approval' THEN 0
             WHEN phase = 'awaiting_test_decision' THEN 1
             WHEN phase = 'awaiting_plan_approval' THEN 2
             ELSE 3
           END,
           ready_at ASC
         LIMIT 1`,
      )
      .get() as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  markInterrupted(message: string, now = new Date()): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE phase IN ('received', 'researching', 'implementing', 'testing', 'repairing', 'deploying')`,
      )
      .all() as unknown as JobRow[];
    return rows.map((row) => {
      const job = mapJob(row);
      const transcript = [...job.transcript, { at: now.toISOString(), text: message }];
      return this.update(job.id, {
        phase: "failed",
        outcome: "failed",
        errorPlain: message,
        progress: "",
        transcript,
      });
    });
  }
}
