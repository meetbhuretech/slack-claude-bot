import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, testConfig, testOrchestrator } from "./helpers.js";
import { phrases } from "../src/copy.js";
import { parseReview } from "../src/claude/parse.js";
import { scrubEnv } from "../src/pipeline/command.js";
import { assertTransition } from "../src/workflow/status.js";
import { renderMessage } from "../src/slack/blocks.js";
import { JobStore } from "../src/store/jobs.js";
import { startHttp } from "../src/http/server.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { silentLogger } from "../src/logger.js";
import { prepareSampleRepo } from "../src/sample/prepare.js";
import { loadConfig } from "../src/config.js";
import { ScriptedClaudeRunner } from "../src/claude/scripted-runner.js";
import { ShellCommandRunner } from "../src/pipeline/command.js";
import { Orchestrator } from "../src/workflow/orchestrator.js";

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("plain language and safety helpers", () => {
  it("keeps the messages free of internal jargon", () => {
    const rendered = [
      phrases.ack(),
      phrases.planIntro(),
      phrases.testsPassed(),
      phrases.testsFailed("The homepage check failed."),
      phrases.deployed("http://127.0.0.1:3000/staging/"),
      phrases.savedNotPublished(),
      phrases.unexpected(),
      phrases.dirtyRepo(),
    ].join("\n");
    expect(rendered).not.toMatch(/permissionMode|worktree|TypeError|stack trace|stderr/i);
  });

  it("reads a review even when the model wraps it in extra text", () => {
    const review = parseReview('Sure\n{"understood":"Change the headline.","needsClarification":false,"question":""}');
    expect(review.understood).toBe("Change the headline.");
    expect(review.needsClarification).toBe(false);
  });

  it("rejects an illegal jump straight to staging", () => {
    expect(() => assertTransition("received", "deploying")).toThrow(/Cannot move/);
  });

  it("removes secrets from command environments", () => {
    const env = scrubEnv({ PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret", ANTHROPIC_API_KEY: "sk-secret" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("shows approval buttons only while a person needs to decide", () => {
    const job = {
      id: "job_abc",
      phase: "awaiting_plan_approval" as const,
      planApproved: false,
      deployApproved: false,
      retryRequested: false,
      transcript: [],
      requestText: "Change the homepage headline to Hello",
      followups: [],
      channelId: "C1",
      threadTs: "1",
      userId: "U1",
      source: "simulator" as const,
      understood: "Headline",
      planSummary: "Plan",
      implementationSummary: "",
      testSummary: "",
      deployUrl: "",
      branch: "",
      worktreePath: "",
      sessionId: "",
      errorPlain: "",
      progress: "",
      repairAttempts: 0,
      slackStatusTs: "",
      readyAt: "",
      createdAt: "",
      updatedAt: "",
    };
    const message = renderMessage(job, "Here is the plan.", false);
    expect(message.text).toContain("Step 2 of 5");
    const actions = message.blocks.find((block) => block.type === "actions");
    expect(JSON.stringify(actions)).toContain("Approve and build");
  });
});

describe("the change pipeline", () => {
  it("plans, builds, checks, and publishes only after both approvals", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-flow-"));
    const repo = await makeRepo(root);
    const marker = path.join(root, "deployed.txt");
    const deployScript = path.join(root, "deploy.cjs");
    writeFileSync(
      deployScript,
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)}, "ok"); console.log("https://staging.example.test/preview");`,
    );
    const config = testConfig(repo, path.join(root, "data"), {
      DEPLOY_COMMAND: `"${process.execPath}" "${deployScript}"`,
    });
    const { store, orchestrator } = testOrchestrator(config, repo);
    closers.push(() => store.close());

    const started = await orchestrator.start({
      channelId: "C1",
      threadTs: "100.1",
      userId: "U1",
      source: "simulator",
      text: "Change the homepage headline to Hello from the team",
    });
    expect(started.accepted).toBe(true);
    if (!started.accepted) return;
    expect(started.job.phase).toBe("awaiting_plan_approval");
    expect(started.job.planSummary).toContain("Hello from the team");
    expect(readFileSync(path.join(repo, "index.html"), "utf8")).toContain("<h1>Welcome</h1>");

    const built = await orchestrator.approvePlan(started.job.id, "U1");
    expect(built.ok).toBe(true);
    expect(built.job.phase).toBe("awaiting_deploy_approval");
    expect(readFileSync(path.join(repo, "index.html"), "utf8")).toContain("<h1>Welcome</h1>");
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);

    const published = await orchestrator.approveDeploy(started.job.id, "U1");
    expect(published.job.phase).toBe("done");
    expect(published.job.outcome).toBe("deployed");
    expect(published.job.deployUrl).toBe("https://staging.example.test/preview");
    expect(readFileSync(marker, "utf8")).toBe("ok");
  });

  it("does not publish when the checks fail", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-fail-"));
    const repo = await makeRepo(root);
    let deploys = 0;
    const config = testConfig(repo, path.join(root, "data"), {
      TEST_COMMAND: `"${process.execPath}" -e "process.exit(1)"`,
      TEST_REPAIR_ATTEMPTS: "0",
      DEPLOY_COMMAND: `"${process.execPath}" -e "process.exit(0)"`,
    });
    const { store, orchestrator } = testOrchestrator(config, repo, {
      async notify() {
        deploys += 0;
      },
    });
    closers.push(() => store.close());
    const started = await orchestrator.start({
      channelId: "C1",
      threadTs: "200.1",
      userId: "U2",
      source: "simulator",
      text: "Change the homepage headline to Hello from the team",
    });
    if (!started.accepted) throw new Error(started.message);
    const built = await orchestrator.approvePlan(started.job.id, "U2");
    expect(built.job.phase).toBe("awaiting_test_decision");
    expect(built.job.transcript.at(-1)?.text).toMatch(/checks failed/i);
    expect(deploys).toBe(0);
    const declined = await orchestrator.cancel(started.job.id, "U2");
    expect(declined.job.phase).toBe("cancelled");
  });

  it("asks a short question when the request is unclear, then continues", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-ask-"));
    const repo = await makeRepo(root);
    const config = testConfig(repo, path.join(root, "data"));
    const { store, orchestrator } = testOrchestrator(config, repo);
    closers.push(() => store.close());
    const started = await orchestrator.start({
      channelId: "C1",
      threadTs: "300.1",
      userId: "U3",
      source: "simulator",
      text: "hi",
    });
    if (!started.accepted) throw new Error(started.message);
    expect(started.job.phase).toBe("clarifying");
    const revised = await orchestrator.reply(
      "C1",
      "300.1",
      "U3",
      "Change the homepage headline to Welcome back",
    );
    expect(revised.accepted).toBe(true);
    if (!revised.accepted) return;
    expect(revised.job.phase).toBe("awaiting_plan_approval");
    expect(revised.job.planSummary).toContain("Welcome back");
  });

  it("stops before editing when the project already has unfinished work", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-dirty-"));
    const repo = await makeRepo(root);
    writeFileSync(path.join(repo, "notes.txt"), "unfinished");
    const config = testConfig(repo, path.join(root, "data"));
    const { store, orchestrator } = testOrchestrator(config, repo);
    closers.push(() => store.close());
    const started = await orchestrator.start({
      channelId: "C1",
      threadTs: "400.1",
      userId: "U4",
      source: "simulator",
      text: "Change the homepage headline to Hello from the team",
    });
    if (!started.accepted) throw new Error(started.message);
    expect(started.job.phase).toBe("failed");
    expect(started.job.errorPlain).toMatch(/unfinished edits/);
  });

  it("keeps staging unchanged when the person leaves it as it is", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-save-"));
    const repo = await makeRepo(root);
    const marker = path.join(root, "deployed.txt");
    const deployScript = path.join(root, "deploy.cjs");
    writeFileSync(deployScript, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");`);
    const config = testConfig(repo, path.join(root, "data"), {
      DEPLOY_COMMAND: `"${process.execPath}" "${deployScript}"`,
    });
    const { store, orchestrator } = testOrchestrator(config, repo);
    closers.push(() => store.close());
    const started = await orchestrator.start({
      channelId: "C1",
      threadTs: "500.1",
      userId: "U5",
      source: "simulator",
      text: "Change the homepage headline to Hello from the team",
    });
    if (!started.accepted) throw new Error(started.message);
    await orchestrator.approvePlan(started.job.id, "U5");
    const saved = await orchestrator.declineDeploy(started.job.id, "U5");
    expect(saved.job.phase).toBe("done");
    expect(saved.job.outcome).toBe("saved");
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores a duplicate Slack event", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-dupe-"));
    const repo = await makeRepo(root);
    const config = testConfig(repo, path.join(root, "data"));
    const { store, orchestrator } = testOrchestrator(config, repo);
    closers.push(() => store.close());
    const first = await orchestrator.start({
      channelId: "C1",
      threadTs: "600.1",
      userId: "U6",
      source: "slack",
      eventId: "Ev1",
      text: "Change the homepage headline to Hello from the team",
    });
    const second = await orchestrator.start({
      channelId: "C1",
      threadTs: "600.1",
      userId: "U6",
      source: "slack",
      eventId: "Ev1",
      text: "Change the homepage headline to Hello from the team",
    });
    expect(first.accepted && second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });
});

describe("practice page", () => {
  it("publishes the sample headline to local staging through the page API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-slack-http-"));
    const dataDir = path.join(root, "data");
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "0",
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      CLAUDE_MODE: "scripted",
      SIMULATOR_ENABLED: "true",
      TEST_COMMAND: `"${process.execPath}" test.js`,
      REQUIRE_PLAN_APPROVAL: "true",
      REQUIRE_DEPLOY_APPROVAL: "true",
      TEST_REPAIR_ATTEMPTS: "0",
      COMMAND_TIMEOUT_MS: "15000",
      CLAUDE_PHASE_TIMEOUT_MS: "20000",
    });
    const repo = await prepareSampleRepo(config);
    config.publicBaseUrl = "http://127.0.0.1:9";
    const store = new JobStore(path.join(dataDir, "jobs.sqlite"));
    const workspace = new GitWorkspace(dataDir);
    const orchestrator = new Orchestrator({
      config,
      store,
      claude: new ScriptedClaudeRunner(),
      workspace,
      commands: new ShellCommandRunner(config),
      notifier: { async notify() {} },
      logger: silentLogger(),
      repoPath: repo,
    });
    const http = await startHttp({
      config,
      orchestrator,
      store,
      logger: silentLogger(),
      projectName: "sample-repo",
      projectReady: async () => true,
    });
    config.publicBaseUrl = `http://127.0.0.1:${http.port}`;
    closers.push(async () => {
      await http.close();
      store.close();
    });

    const home = await fetch(`http://127.0.0.1:${http.port}/`);
    expect(await home.text()).toContain("Project assistant");
    const health = await fetch(`http://127.0.0.1:${http.port}/health`);
    expect(health.status).toBe(200);

    const created = await fetch(`http://127.0.0.1:${http.port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Change the homepage headline to Hello from the team" }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { job: { id: string; phase: string } };
    const ready = await waitFor(http.port, createdBody.job.id, (job) => job.actions.includes("approve_plan"));
    expect(ready.planSummary).toContain("Hello from the team");

    const approved = await fetch(`http://127.0.0.1:${http.port}/api/jobs/${ready.id}/approve-plan`, { method: "POST" });
    expect(approved.status).toBe(200);
    const checked = await waitFor(http.port, ready.id, (job) => job.actions.includes("approve_deploy"));
    expect(checked.implementationSummary).toContain("Hello from the team");
    expect(readFileSync(path.join(repo, "index.html"), "utf8")).toContain("<h1>Welcome</h1>");

    const publish = await fetch(`http://127.0.0.1:${http.port}/api/jobs/${ready.id}/approve-deploy`, { method: "POST" });
    expect(publish.status).toBe(200);
    const done = await waitFor(http.port, ready.id, (job) => job.phase === "done");
    expect(done.deployUrl).toContain("/staging/");
    const staging = await fetch(done.deployUrl);
    expect(staging.status).toBe(200);
    expect(await staging.text()).toContain("<h1>Hello from the team</h1>");
  });
});

interface ApiJob {
  id: string;
  phase: string;
  planSummary: string;
  implementationSummary: string;
  deployUrl: string;
  actions: string[];
}

async function waitFor(port: number, id: string, predicate: (job: ApiJob) => boolean): Promise<ApiJob> {
  const started = Date.now();
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`);
    const body = (await response.json()) as { job: ApiJob };
    if (predicate(body.job)) return body.job;
    if (body.job.phase === "failed" || body.job.phase === "cancelled") {
      throw new Error(`Job ended as ${body.job.phase}: ${JSON.stringify(body.job)}`);
    }
    if (Date.now() - started > 15000) throw new Error(`Timed out waiting. Last phase: ${body.job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
