import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { prepareSampleRepo } from "../src/sample/prepare.js";
import { ScriptedClaudeRunner } from "../src/claude/scripted-runner.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { ShellCommandRunner } from "../src/pipeline/command.js";
import { JobStore } from "../src/store/jobs.js";
import { Orchestrator } from "../src/workflow/orchestrator.js";

const root = mkdtempSync(path.join(tmpdir(), "claude-slack-demo-"));
const config = loadConfig({
  NODE_ENV: "development",
  DATA_DIR: path.join(root, "data"),
  CLAUDE_MODE: "scripted",
  REQUIRE_PLAN_APPROVAL: "true",
  REQUIRE_DEPLOY_APPROVAL: "true",
  TEST_REPAIR_ATTEMPTS: "0",
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
});
const repo = await prepareSampleRepo(config);
const store = new JobStore(path.join(config.dataDir, "jobs.sqlite"));
const orchestrator = new Orchestrator({
  config,
  store,
  claude: new ScriptedClaudeRunner(),
  workspace: new GitWorkspace(config.dataDir),
  commands: new ShellCommandRunner(config),
  notifier: { async notify() {} },
  logger: silentLogger(),
  repoPath: repo,
});

const started = await orchestrator.start({
  channelId: "demo",
  threadTs: "demo-1",
  userId: "demo-user",
  source: "demo",
  text: "Change the homepage headline to Hello from the team",
});
if (!started.accepted) throw new Error(started.message);
print(started.job.transcript.at(-1)?.text ?? "");

const built = await orchestrator.approvePlan(started.job.id, "demo-user");
print("A person tapped Approve and build.");
print(built.job.transcript.at(-1)?.text ?? "");

const published = await orchestrator.approveDeploy(started.job.id, "demo-user");
print("A person tapped Publish to staging.");
print(published.job.transcript.at(-1)?.text ?? "");
console.log(`\nStaging link: ${published.job.deployUrl}`);
store.close();

function print(text: string): void {
  console.log(`\n${text}\n`);
}
