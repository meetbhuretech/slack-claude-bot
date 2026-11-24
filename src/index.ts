import "dotenv/config";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { JobStore } from "./store/jobs.js";
import { GitWorkspace } from "./git/workspace.js";
import { ShellCommandRunner } from "./pipeline/command.js";
import { ScriptedClaudeRunner, UnavailableClaudeRunner } from "./claude/scripted-runner.js";
import { SdkClaudeRunner } from "./claude/sdk-runner.js";
import { Orchestrator } from "./workflow/orchestrator.js";
import { phrases } from "./copy.js";
import { prepareSampleRepo } from "./sample/prepare.js";
import { startHttp } from "./http/server.js";
import { startSlack } from "./slack/app.js";
import { renderMessage } from "./slack/blocks.js";
import type { ClaudeRunner, Notifier } from "./types.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error("This app needs Node.js 22 or newer. Run: nvm use 22");
  process.exit(1);
}

class NoopNotifier implements Notifier {
  async notify(): Promise<void> {}
}

function chooseRunner(config: ReturnType<typeof loadConfig>): ClaudeRunner {
  if (config.claudeMode === "live") {
    if (!config.anthropicApiKey) return new UnavailableClaudeRunner(phrases.missingClaude());
    return new SdkClaudeRunner(config);
  }
  if (config.projectMode === "sample") return new ScriptedClaudeRunner();
  return new UnavailableClaudeRunner(phrases.missingClaude());
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (config.slackBotToken && !config.slackBotToken.startsWith("xoxb-")) {
    logger.warn("SLACK_BOT_TOKEN should start with xoxb-");
  }
  if (config.slackAppToken && !config.slackAppToken.startsWith("xapp-")) {
    logger.warn("SLACK_APP_TOKEN should start with xapp-");
  }

  const repoPath = config.projectMode === "sample" ? await prepareSampleRepo(config) : config.targetRepoPath ?? "";
  const store = new JobStore(path.join(config.dataDir, "jobs.sqlite"));
  const interrupted = store.markInterrupted(phrases.restarted());
  const workspace = new GitWorkspace(config.dataDir);
  const commands = new ShellCommandRunner(config);
  const runner = chooseRunner(config);
  const runtime = {
    config,
    store,
    claude: runner,
    workspace,
    commands,
    notifier: new NoopNotifier() as Notifier,
    logger,
    repoPath,
  };
  const orchestrator = new Orchestrator(runtime);

  let slackClose: (() => Promise<void>) | undefined;
  if (config.slackEnabled) {
    const slack = await startSlack({ config, orchestrator, store, logger });
    runtime.notifier = slack.notifier;
    slackClose = slack.close;
  } else {
    logger.info("Slack is not connected. The practice page is available.");
  }

  for (const job of interrupted) {
    await runtime.notifier.notify(job, renderMessage(job, job.errorPlain, false));
  }
  orchestrator.resumePending();

  const http = await startHttp({
    config,
    orchestrator,
    store,
    logger,
    projectName: repoPath ? path.basename(repoPath) : "project",
    projectReady: async () => {
      if (!repoPath) return false;
      try {
        await workspace.assertReady(repoPath);
        return true;
      } catch {
        return false;
      }
    },
  });

  logger.info("Project assistant is listening", {
    url: `${config.publicBaseUrl || `http://127.0.0.1:${http.port}`}`,
    port: http.port,
    projectMode: config.projectMode,
    claudeMode: config.claudeMode,
    slack: config.slackEnabled,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info("Shutting down", { signal });
    store.markInterrupted(phrases.restarted());
    await http.close();
    if (slackClose) await slackClose();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
