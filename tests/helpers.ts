import { execFile } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, type AppConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { ScriptedClaudeRunner } from "../src/claude/scripted-runner.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { ShellCommandRunner } from "../src/pipeline/command.js";
import { JobStore } from "../src/store/jobs.js";
import { sampleTemplateDir } from "../src/sample/prepare.js";
import { Orchestrator } from "../src/workflow/orchestrator.js";
import type { Notifier } from "../src/types.js";

const exec = promisify(execFile);

export async function makeRepo(parent = mkdtempSync(path.join(tmpdir(), "claude-slack-"))): Promise<string> {
  const repo = path.join(parent, "repo");
  cpSync(sampleTemplateDir(), repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  await exec("git", ["-C", repo, "add", "-A"]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return repo;
}

export function testConfig(repo: string, dataDir: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    TARGET_REPO_PATH: repo,
    TEST_COMMAND: `"${process.execPath}" test.js`,
    REQUIRE_PLAN_APPROVAL: "true",
    REQUIRE_DEPLOY_APPROVAL: "true",
    TEST_REPAIR_ATTEMPTS: "1",
    CLAUDE_MODE: "scripted",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    COMMAND_TIMEOUT_MS: "15000",
    CLAUDE_PHASE_TIMEOUT_MS: "20000",
    ...overrides,
  });
}

export function testOrchestrator(config: AppConfig, repo: string, notifier: Notifier = { async notify() {} }) {
  const store = new JobStore(path.join(config.dataDir, "jobs.sqlite"));
  const orchestrator = new Orchestrator({
    config,
    store,
    claude: new ScriptedClaudeRunner(),
    workspace: new GitWorkspace(config.dataDir),
    commands: new ShellCommandRunner(config),
    notifier,
    logger: silentLogger(),
    repoPath: repo,
  });
  return { store, orchestrator };
}
