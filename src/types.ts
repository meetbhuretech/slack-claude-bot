export const phases = [
  "received",
  "queued",
  "researching",
  "clarifying",
  "awaiting_plan_approval",
  "implementing",
  "testing",
  "repairing",
  "awaiting_test_decision",
  "awaiting_deploy_approval",
  "deploying",
  "done",
  "failed",
  "cancelled",
] as const;

export type Phase = (typeof phases)[number];

export type Outcome = "deployed" | "saved" | "stopped" | "failed";

export type JobSource = "slack" | "simulator" | "demo";

export type ActionName =
  | "approve_plan"
  | "revise"
  | "cancel"
  | "approve_deploy"
  | "decline_deploy"
  | "retry";

export interface TranscriptEntry {
  at: string;
  text: string;
}

export interface Job {
  id: string;
  channelId: string;
  threadTs: string;
  userId: string;
  source: JobSource;
  eventId?: string;
  requestText: string;
  followups: string[];
  phase: Phase;
  understood: string;
  planSummary: string;
  implementationSummary: string;
  testSummary: string;
  deployUrl: string;
  branch: string;
  worktreePath: string;
  sessionId: string;
  errorPlain: string;
  progress: string;
  outcome?: Outcome;
  repairAttempts: number;
  planApproved: boolean;
  deployApproved: boolean;
  retryRequested: boolean;
  slackStatusTs: string;
  transcript: TranscriptEntry[];
  readyAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewJob {
  channelId: string;
  threadTs: string;
  userId: string;
  source: JobSource;
  eventId?: string;
  requestText: string;
  phase: Phase;
}

export type JobPatch = Partial<
  Omit<Job, "id" | "createdAt" | "channelId" | "threadTs" | "userId" | "source" | "requestText">
> & {
  requestText?: string;
};

export interface StartInput {
  channelId: string;
  threadTs: string;
  userId: string;
  source: JobSource;
  text: string;
  eventId?: string;
}

export type StartResult =
  | { accepted: true; duplicate: boolean; job: Job }
  | { accepted: false; message: string };

export interface OutboundMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
  replaceStatus: boolean;
}

export interface Notifier {
  notify(job: Job, message: OutboundMessage): Promise<void>;
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export type ClaudeTask = "review" | "research" | "implement" | "repair";

export interface ClaudeRunInput {
  task: ClaudeTask;
  prompt: string;
  requestText: string;
  cwd: string;
  resumeSessionId?: string;
  maxBudgetUsd: number;
  maxTurns: number;
  model?: string;
  signal: AbortSignal;
  onProgress?: (line: string) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  errorCode?: "budget" | "turns" | "execution" | "cancelled" | "config" | "timeout";
  errorDetail?: string;
}

export interface ClaudeRunner {
  run(input: ClaudeRunInput): Promise<ClaudeRunResult>;
}

export interface PreparedWorkspace {
  branch: string;
  path: string;
}

export interface Workspace {
  assertReady(repoPath: string): Promise<void>;
  prepare(repoPath: string, jobId: string, slug: string, baseBranch?: string): Promise<PreparedWorkspace>;
  diffStat(worktreePath: string): Promise<string>;
  commit(worktreePath: string, message: string): Promise<string | null>;
  release(repoPath: string, worktreePath: string): Promise<void>;
  remove(repoPath: string, worktreePath: string, branch: string): Promise<void>;
}

export interface CommandResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(command: string, cwd: string, signal: AbortSignal): Promise<CommandResult>;
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
