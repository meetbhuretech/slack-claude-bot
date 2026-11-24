import type { AppConfig } from "../config.js";
import { phrases } from "../copy.js";
import { implementPrompt, repairPrompt, researchPrompt, reviewPrompt } from "../claude/prompts.js";
import { parseReview } from "../claude/parse.js";
import { JobStore } from "../store/jobs.js";
import { lastLine, slugify, tail } from "../text.js";
import {
  UserFacingError,
  type ClaudeRunner,
  type CommandRunner,
  type Job,
  type Logger,
  type Notifier,
  type StartInput,
  type StartResult,
  type Workspace,
} from "../types.js";
import { isTerminal } from "./status.js";
import { renderMessage } from "../slack/blocks.js";

export interface ActionResult {
  ok: boolean;
  message?: string;
  job: Job;
}

interface OrchestratorOptions {
  wait?: boolean;
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export class Orchestrator {
  private queue: string[] = [];
  private draining = false;
  private hold = false;
  private controllers = new Map<string, AbortController>();
  private cancelReason = new Map<string, "user" | "timeout">();
  private progressAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      store: JobStore;
      claude: ClaudeRunner;
      workspace: Workspace;
      commands: CommandRunner;
      notifier: Notifier;
      logger: Logger;
      repoPath: string;
    },
  ) {}

  async start(input: StartInput, options: OrchestratorOptions = {}): Promise<StartResult> {
    const text = input.text.trim();
    if (!text) return { accepted: false, message: phrases.emptyRequest() };
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (this.deps.store.countRecentByUser(input.userId, since) >= this.deps.config.maxJobsPerUserPerHour) {
      return { accepted: false, message: phrases.rateLimit() };
    }
    if (!this.deps.repoPath) return { accepted: false, message: phrases.missingRepo() };
    if (input.eventId) {
      const reservation = this.deps.store.reserveEvent(input.eventId);
      if (!reservation.reserved) {
        if (reservation.job) return { accepted: true, duplicate: true, job: reservation.job };
        return { accepted: false, message: "I'm already picking up that message." };
      }
    }

    const busy = this.draining || this.hold || this.queue.length > 0;
    const job = this.deps.store.create({
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.userId,
      source: input.source,
      eventId: input.eventId,
      requestText: text,
      phase: busy ? "queued" : "received",
    });
    if (input.eventId) this.deps.store.attachEvent(input.eventId, job.id);
    this.queue.push(job.id);
    const leader = !busy;
    if (leader) this.hold = true;
    try {
      await this.say(job, busy ? phrases.queued() : phrases.ack());
    } finally {
      if (leader) {
        this.hold = false;
        this.startDrain();
      }
    }

    if (options.wait === false || busy) {
      return { accepted: true, duplicate: false, job: this.deps.store.must(job.id) };
    }
    const settled = await this.waitUntil(
      job.id,
      (current) => current.phase !== "received" && current.phase !== "researching",
    );
    return { accepted: true, duplicate: false, job: settled };
  }

  async reply(
    channelId: string,
    threadTs: string,
    userId: string,
    text: string,
    options: OrchestratorOptions = {},
  ): Promise<StartResult> {
    const existing = this.deps.store.findByThread(channelId, threadTs);
    const clean = text.trim();
    if (!clean) return { accepted: false, message: phrases.emptyRequest() };
    if (!existing || isTerminal(existing.phase)) {
      return this.start({
        channelId,
        threadTs,
        userId,
        source: existing?.source ?? "slack",
        text: clean,
      });
    }
    if (existing.phase !== "clarifying" && existing.phase !== "awaiting_plan_approval") {
      return { accepted: false, message: "I'm still working on this. I'll post here when I need you." };
    }
    const next = this.deps.store.update(existing.id, {
      followups: [...existing.followups, clean],
      phase: "queued",
      planApproved: false,
      understood: "",
      planSummary: "",
      readyAt: new Date().toISOString(),
    });
    await this.say(next, "Thanks. I'll read the project again with that.");
    this.enqueue(next.id, true);
    if (options?.wait === false) return { accepted: true, duplicate: false, job: this.deps.store.must(next.id) };
    const settled = await this.waitUntil(
      next.id,
      (current) => current.phase !== "queued" && current.phase !== "researching",
    );
    return { accepted: true, duplicate: false, job: settled };
  }

  async approvePlan(id: string, userId: string, options: OrchestratorOptions = {}): Promise<ActionResult> {
    const denied = this.guard(id, userId, "awaiting_plan_approval");
    if (denied) return denied;
    const next = this.deps.store.update(id, { planApproved: true, readyAt: new Date().toISOString() });
    await this.say(next, "Approved. I'll make the change and run the checks.");
    this.enqueue(id, true);
    if (options.wait === false) return { ok: true, job: this.deps.store.must(id) };
    const job = await this.waitUntil(id, (current) => this.buildSettled(current));
    return { ok: true, job };
  }

  async requestChange(id: string, userId: string): Promise<ActionResult> {
    const denied = this.guard(id, userId, "awaiting_plan_approval");
    if (denied) return denied;
    const next = this.deps.store.update(id, { phase: "clarifying", planApproved: false });
    await this.say(next, phrases.revisePrompt());
    return { ok: true, job: this.deps.store.must(id) };
  }

  async approveDeploy(id: string, userId: string, options: OrchestratorOptions = {}): Promise<ActionResult> {
    const denied = this.guard(id, userId, "awaiting_deploy_approval");
    if (denied) return denied;
    const next = this.deps.store.update(id, { deployApproved: true, readyAt: new Date().toISOString() });
    await this.say(next, "Approved. I'm publishing to staging.");
    this.enqueue(id, true);
    if (options.wait === false) return { ok: true, job: this.deps.store.must(id) };
    const job = await this.waitUntil(id, (current) => isTerminal(current.phase) || current.phase === "failed");
    return { ok: true, job };
  }

  async declineDeploy(id: string, userId: string): Promise<ActionResult> {
    const denied = this.guard(id, userId, "awaiting_deploy_approval");
    if (denied) return denied;
    const next = this.deps.store.update(id, {
      phase: "done",
      outcome: "saved",
      deployApproved: false,
      progress: "",
    });
    await this.releaseWorktree(next);
    await this.say(this.deps.store.must(id), `${next.implementationSummary}\n\n${phrases.savedNotPublished()}`.trim());
    return { ok: true, job: this.deps.store.must(id) };
  }

  async retry(id: string, userId: string, options: OrchestratorOptions = {}): Promise<ActionResult> {
    const denied = this.guard(id, userId, "awaiting_test_decision");
    if (denied) return denied;
    const current = this.deps.store.must(id);
    if (current.repairAttempts >= this.deps.config.testRepairAttempts + 2) {
      await this.fail(id, new UserFacingError(phrases.tooManyRetries()));
      return { ok: false, message: phrases.tooManyRetries(), job: this.deps.store.must(id) };
    }
    const next = this.deps.store.update(id, { retryRequested: true, readyAt: new Date().toISOString() });
    await this.say(next, "I'll try that again.");
    this.enqueue(id, true);
    if (options.wait === false) return { ok: true, job: this.deps.store.must(id) };
    const job = await this.waitUntil(id, (item) => this.buildSettled(item) && !item.retryRequested);
    return { ok: true, job };
  }

  resumePending(): void {
    for (const job of this.deps.store.listRunnable()) this.enqueue(job.id, false);
  }

  async cancel(id: string, userId: string): Promise<ActionResult> {
    const job = this.deps.store.get(id);
    if (!job) return { ok: false, message: phrases.wrongStep(), job: this.missingJob(id) };
    if (!this.canDecide(job, userId)) return { ok: false, message: phrases.notAllowed(), job };
    if (isTerminal(job.phase)) return { ok: false, message: phrases.wrongStep(), job };
    this.cancelReason.set(id, "user");
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      return { ok: true, job };
    }
    await this.finishCancelled(id);
    return { ok: true, job: this.deps.store.must(id) };
  }

  private guard(id: string, userId: string, phase: Job["phase"]): ActionResult | undefined {
    const job = this.deps.store.get(id);
    if (!job || job.phase !== phase) {
      return { ok: false, message: phrases.wrongStep(), job: job ?? this.missingJob(id) };
    }
    if (!this.canDecide(job, userId)) return { ok: false, message: phrases.notAllowed(), job };
    if (phase === "awaiting_plan_approval" && job.planApproved) return { ok: false, message: phrases.wrongStep(), job };
    if (phase === "awaiting_deploy_approval" && job.deployApproved) {
      return { ok: false, message: phrases.wrongStep(), job };
    }
    return undefined;
  }

  private missingJob(id: string): Job {
    return {
      id,
      channelId: "",
      threadTs: "",
      userId: "",
      source: "simulator",
      requestText: "",
      followups: [],
      phase: "failed",
      understood: "",
      planSummary: "",
      implementationSummary: "",
      testSummary: "",
      deployUrl: "",
      branch: "",
      worktreePath: "",
      sessionId: "",
      errorPlain: phrases.wrongStep(),
      progress: "",
      outcome: "failed",
      repairAttempts: 0,
      planApproved: false,
      deployApproved: false,
      retryRequested: false,
      slackStatusTs: "",
      transcript: [],
      readyAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private canDecide(job: Job, userId: string): boolean {
    if (!this.deps.config.approverUserIds.length) return true;
    return job.userId === userId || this.deps.config.approverUserIds.includes(userId);
  }

  private enqueue(id: string, first: boolean): void {
    if (!this.queue.includes(id)) {
      if (first) this.queue.unshift(id);
      else this.queue.push(id);
    }
    if (this.hold) return;
    this.startDrain();
  }

  private startDrain(): void {
    if (this.draining || this.hold || this.queue.length === 0) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        if (!id) break;
        await this.advance(id);
      }
    } finally {
      this.draining = false;
      this.startDrain();
    }
  }

  private async advance(id: string): Promise<void> {
    const existing = this.deps.store.get(id);
    if (!existing || isTerminal(existing.phase)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timer = setTimeout(() => {
      this.cancelReason.set(id, "timeout");
      controller.abort();
    }, this.deps.config.phaseTimeoutMs);
    try {
      await this.pipeline(id, controller.signal);
    } catch (error) {
      try {
        if (error instanceof Cancelled || controller.signal.aborted) await this.finishCancelled(id);
        else await this.fail(id, error);
      } catch (secondary) {
        this.deps.logger.error("could not record the failure", {
          jobId: id,
          error: secondary instanceof Error ? secondary.message : String(secondary),
        });
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
      this.cancelReason.delete(id);
    }
  }

  private async pipeline(id: string, signal: AbortSignal): Promise<void> {
    for (let step = 0; step < 8; step += 1) {
      this.throwIfAborted(signal);
      const job = this.deps.store.must(id);
      if (isTerminal(job.phase)) return;
      if (job.phase === "received" || job.phase === "queued") {
        await this.research(id, signal);
        continue;
      }
      if (job.phase === "awaiting_plan_approval" && job.planApproved) {
        await this.buildAndCheck(id, signal);
        continue;
      }
      if (job.phase === "awaiting_test_decision" && job.retryRequested) {
        await this.repairAndRetest(id, signal);
        continue;
      }
      if (job.phase === "awaiting_deploy_approval" && job.deployApproved) {
        await this.publish(id, signal);
        continue;
      }
      return;
    }
  }

  private async research(id: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    let job = this.deps.store.update(id, { phase: "researching", progress: phrases.researching(), errorPlain: "" });
    await this.noteProgress(id, phrases.researching());
    await this.deps.workspace.assertReady(this.deps.repoPath);
    const request = this.fullRequest(this.deps.store.must(id));
    const review = await this.runClaude(job, "review", reviewPrompt(request), this.deps.repoPath, signal);
    const parsed = parseReview(review.text);
    if (parsed.needsClarification) {
      job = this.deps.store.update(id, {
        phase: "clarifying",
        understood: parsed.understood,
        progress: "",
        sessionId: review.sessionId ?? "",
      });
      await this.say(job, phrases.question(parsed.question || "What would you like me to change?"));
      return;
    }
    await this.noteProgress(id, "I'm looking through the project.");
    const research = await this.runClaude(
      this.deps.store.must(id),
      "research",
      researchPrompt(request, parsed.understood),
      this.deps.repoPath,
      signal,
    );
    const approved = !this.deps.config.requirePlanApproval;
    job = this.deps.store.update(id, {
      phase: "awaiting_plan_approval",
      understood: parsed.understood,
      planSummary: research.text.trim() || parsed.understood,
      sessionId: research.sessionId ?? review.sessionId ?? "",
      planApproved: approved,
      progress: "",
      readyAt: new Date().toISOString(),
    });
    await this.say(job, this.planBody(job));
  }

  private async buildAndCheck(id: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    let job = this.deps.store.update(id, { phase: "implementing", progress: phrases.implementing() });
    await this.noteProgress(id, phrases.implementing());
    const prepared = await this.deps.workspace.prepare(
      this.deps.repoPath,
      job.id,
      slugify(job.requestText),
      this.deps.config.baseBranch,
    );
    job = this.deps.store.update(id, { branch: prepared.branch, worktreePath: prepared.path });
    const request = this.fullRequest(job);
    const implemented = await this.runClaude(
      job,
      "implement",
      implementPrompt(request, job.planSummary),
      prepared.path,
      signal,
      phrases.claudeImplementFailed(),
    );
    const sha = await this.deps.workspace.commit(prepared.path, this.commitMessage(job));
    if (!sha) {
      await this.fail(id, new UserFacingError(phrases.noChanges()));
      return;
    }
    const summary = implemented.text.trim() || "I updated the project.";
    job = this.deps.store.update(id, {
      implementationSummary: summary,
      sessionId: implemented.sessionId ?? job.sessionId,
    });
    if (this.deps.config.setupCommand) {
      const setup = await this.deps.commands.run(this.deps.config.setupCommand, prepared.path, signal);
      this.throwIfAborted(signal);
      if (!setup.ok) {
        await this.fail(id, new UserFacingError(phrases.setupFailed(lastLine(setup.output))));
        return;
      }
    }
    await this.executeTests(id, signal);
  }

  private async executeTests(id: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    let job = this.deps.store.update(id, { phase: "testing", progress: "Running the checks" });
    await this.noteProgress(id, "I'm running the checks.");
    const result = await this.deps.commands.run(this.deps.config.testCommand, job.worktreePath, signal);
    this.throwIfAborted(signal);
    if (result.ok) {
      await this.offerDeploy(id);
      return;
    }
    const summary = result.timedOut ? "The checks took too long and were stopped." : lastLine(result.output);
    job = this.deps.store.update(id, { testSummary: tail(result.output) });
    if (job.repairAttempts < this.deps.config.testRepairAttempts) {
      await this.repairAndRetest(id, signal, result.output);
      return;
    }
    job = this.deps.store.update(id, {
      phase: "awaiting_test_decision",
      retryRequested: false,
      progress: "",
      errorPlain: summary,
    });
    await this.say(job, phrases.testsFailed(summary));
  }

  private async repairAndRetest(id: string, signal: AbortSignal, output?: string): Promise<void> {
    this.throwIfAborted(signal);
    let job = this.deps.store.must(id);
    if (job.repairAttempts >= this.deps.config.testRepairAttempts + 2) {
      await this.fail(id, new UserFacingError(phrases.tooManyRetries()));
      return;
    }
    job = this.deps.store.update(id, {
      phase: "repairing",
      repairAttempts: job.repairAttempts + 1,
      retryRequested: false,
      progress: "Fixing the checks",
    });
    await this.noteProgress(id, "The checks failed. I'm fixing that and I'll run them again.");
    const request = this.fullRequest(job);
    await this.runClaude(
      job,
      "repair",
      repairPrompt(request, job.planSummary, output || job.testSummary),
      job.worktreePath,
      signal,
      phrases.claudeImplementFailed(),
    );
    await this.deps.workspace.commit(job.worktreePath, "Fix the checks");
    await this.executeTests(id, signal);
  }

  private async offerDeploy(id: string): Promise<void> {
    const current = this.deps.store.must(id);
    const summary = current.implementationSummary || "I updated the project.";
    const technical = this.deps.config.showTechnicalDetails && current.branch ? `\n\nBranch: ${current.branch}` : "";
    if (!this.deps.config.deployCommand) {
      const done = this.deps.store.update(id, {
        phase: "done",
        outcome: "saved",
        progress: "",
        errorPlain: "",
      });
      await this.say(done, `${summary}\n\nThe checks passed. Staging is not configured, so I saved the change and left staging as it was.${technical}`);
      return;
    }
    const approved = !this.deps.config.requireDeployApproval;
    const next = this.deps.store.update(id, {
      phase: "awaiting_deploy_approval",
      deployApproved: approved,
      progress: "",
      errorPlain: "",
      readyAt: new Date().toISOString(),
    });
    const closing = approved ? "The checks passed. I'll publish to staging next." : phrases.testsPassed();
    await this.say(next, `${summary}\n\n${closing}${technical}`);
  }

  private async publish(id: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const job = this.deps.store.update(id, { phase: "deploying", progress: "Publishing to staging" });
    await this.noteProgress(id, "I'm publishing to staging.");
    if (!this.deps.config.deployCommand || !job.worktreePath) {
      await this.fail(id, new UserFacingError(phrases.deployFailed()));
      return;
    }
    const result = await this.deps.commands.run(this.deps.config.deployCommand, job.worktreePath, signal);
    this.throwIfAborted(signal);
    if (!result.ok) {
      await this.fail(id, new UserFacingError(`${phrases.deployFailed()} ${lastLine(result.output)}`.trim()));
      return;
    }
    const url = extractUrlSafe(result.output);
    const done = this.deps.store.update(id, {
      phase: "done",
      outcome: "deployed",
      deployUrl: url,
      progress: "",
      errorPlain: "",
    });
    await this.releaseWorktree(done);
    await this.say(this.deps.store.must(id), phrases.deployed(url));
  }

  private async releaseWorktree(job: Job): Promise<void> {
    if (!job.worktreePath) return;
    await this.deps.workspace.release(this.deps.repoPath, job.worktreePath).catch((error: unknown) => {
      this.deps.logger.warn("could not tidy the temporary folder", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async runClaude(
    job: Job,
    task: "review" | "research" | "implement" | "repair",
    prompt: string,
    cwd: string,
    signal: AbortSignal,
    fallback = phrases.claudeResearchFailed(),
  ) {
    const result = await this.deps.claude.run({
      task,
      prompt,
      requestText: this.fullRequest(job),
      cwd,
      resumeSessionId: task === "repair" ? job.sessionId || undefined : undefined,
      maxBudgetUsd: this.deps.config.maxBudgetUsd,
      maxTurns: this.deps.config.maxTurns,
      model: this.deps.config.model,
      signal,
      onProgress: (line) => {
        void this.noteProgress(job.id, line);
      },
    });
    if (result.costUsd !== undefined) {
      this.deps.logger.info("claude call finished", { jobId: job.id, task, costUsd: result.costUsd });
    }
    if (result.ok) return result;
    if (result.errorCode === "cancelled") throw new Cancelled();
    if (result.errorCode === "budget") throw new UserFacingError(phrases.budget());
    if (result.errorCode === "turns") throw new UserFacingError(phrases.turns());
    if (result.errorCode === "timeout") throw new UserFacingError(phrases.timedOut());
    if (result.errorCode === "config") throw new UserFacingError(result.errorDetail || phrases.missingClaude());
    throw new UserFacingError(fallback);
  }

  private async fail(id: string, error: unknown): Promise<void> {
    const job = this.deps.store.get(id);
    if (!job || isTerminal(job.phase)) return;
    const text = error instanceof UserFacingError ? error.message : phrases.unexpected();
    if (error instanceof UserFacingError) this.deps.logger.info("job stopped", { jobId: id, message: text });
    else {
      this.deps.logger.error("job failed", {
        jobId: id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
    const next = this.deps.store.update(id, { phase: "failed", outcome: "failed", errorPlain: text, progress: "" });
    await this.say(next, text);
  }

  private async finishCancelled(id: string): Promise<void> {
    const job = this.deps.store.get(id);
    if (!job || isTerminal(job.phase)) return;
    const reason = this.cancelReason.get(id);
    if (job.worktreePath) {
      await this.deps.workspace.remove(this.deps.repoPath, job.worktreePath, job.branch).catch((error: unknown) => {
        this.deps.logger.warn("could not remove the temporary change", {
          jobId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const timedOut = reason === "timeout";
    const next = this.deps.store.update(id, {
      phase: timedOut ? "failed" : "cancelled",
      outcome: timedOut ? "failed" : "stopped",
      errorPlain: timedOut ? phrases.timedOut() : "",
      progress: "",
    });
    await this.say(next, timedOut ? phrases.timedOut() : phrases.cancelled());
  }

  private async say(job: Job, text: string): Promise<Job> {
    const current = this.deps.store.must(job.id);
    const transcript = [...current.transcript, { at: new Date().toISOString(), text }];
    const next = this.deps.store.update(job.id, { transcript, progress: "" });
    await this.deps.notifier.notify(next, renderMessage(next, text, false));
    return this.deps.store.must(job.id);
  }

  private async noteProgress(id: string, text: string): Promise<void> {
    const now = Date.now();
    const previous = this.progressAt.get(id) ?? 0;
    const current = this.deps.store.get(id);
    if (!current || isTerminal(current.phase)) return;
    if (current.progress === text && now - previous < 4000) return;
    this.progressAt.set(id, now);
    const next = this.deps.store.update(id, { progress: text });
    await this.deps.notifier.notify(next, renderMessage(next, text, true));
  }

  private fullRequest(job: Job): string {
    if (!job.followups.length) return job.requestText;
    return `${job.requestText}\n\nThey added:\n${job.followups.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
  }

  private planBody(job: Job): string {
    const closing = job.planApproved
      ? "I'll make this change and run the checks next."
      : phrases.planIntro();
    return [job.understood ? `I understood: ${job.understood}` : "", job.planSummary, closing]
      .filter(Boolean)
      .join("\n\n");
  }

  private commitMessage(job: Job): string {
    const line = job.understood || job.requestText;
    return line.replace(/\s+/g, " ").slice(0, 72);
  }

  private buildSettled(job: Job): boolean {
    return !["awaiting_plan_approval", "implementing", "testing", "repairing", "queued", "received", "researching"].includes(
      job.phase,
    );
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Cancelled();
  }

  private async waitUntil(id: string, predicate: (job: Job) => boolean): Promise<Job> {
    const started = Date.now();
    for (;;) {
      const job = this.deps.store.must(id);
      if (predicate(job)) return job;
      if (Date.now() - started > this.deps.config.phaseTimeoutMs) {
        throw new UserFacingError(phrases.timedOut());
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

function extractUrlSafe(output: string): string {
  const matches = output.match(/https?:\/\/[^\s]+/g);
  return matches?.at(-1)?.replace(/[).,]+$/g, "") ?? "";
}
