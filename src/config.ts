import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const rawSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.string().default("development"),
  DATA_DIR: z.string().default(".data"),
  TARGET_REPO_PATH: z.string().optional(),
  BASE_BRANCH: z.string().optional(),
  TEST_COMMAND: z.string().optional(),
  SETUP_COMMAND: z.string().optional(),
  DEPLOY_COMMAND: z.string().optional(),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  REQUIRE_PLAN_APPROVAL: z.string().optional(),
  REQUIRE_DEPLOY_APPROVAL: z.string().optional(),
  TEST_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  CLAUDE_MAX_BUDGET_USD: z.coerce.number().positive().default(3),
  CLAUDE_MAX_TURNS: z.coerce.number().int().positive().default(30),
  CLAUDE_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODE: z.enum(["auto", "scripted", "live"]).default("auto"),
  CLAUDE_PHASE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  APPROVER_USER_IDS: z.string().optional(),
  MAX_JOBS_PER_USER_PER_HOUR: z.coerce.number().int().positive().default(8),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  ADMIN_TOKEN: z.string().optional(),
  SIMULATOR_ENABLED: z.string().optional(),
  SHOW_TECHNICAL_DETAILS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  dataDir: string;
  appRoot: string;
  projectMode: "sample" | "repo";
  targetRepoPath?: string;
  baseBranch?: string;
  testCommand: string;
  setupCommand?: string;
  deployCommand?: string;
  publicBaseUrl: string;
  requirePlanApproval: boolean;
  requireDeployApproval: boolean;
  testRepairAttempts: number;
  maxBudgetUsd: number;
  maxTurns: number;
  model?: string;
  anthropicApiKey?: string;
  claudeMode: "scripted" | "live";
  phaseTimeoutMs: number;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackEnabled: boolean;
  approverUserIds: string[];
  maxJobsPerUserPerHour: number;
  commandTimeoutMs: number;
  adminToken?: string;
  simulatorEnabled: boolean;
  showTechnicalDetails: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.parse(env);
  const targetRepoPath = blankToUndefined(parsed.TARGET_REPO_PATH);
  const projectMode = targetRepoPath ? "repo" : "sample";
  const production = parsed.NODE_ENV === "production";
  const apiKey = blankToUndefined(parsed.ANTHROPIC_API_KEY);
  const requestedMode = parsed.CLAUDE_MODE;
  const claudeMode = requestedMode === "auto" ? (apiKey ? "live" : "scripted") : requestedMode;
  const simulatorRequested = flag(parsed.SIMULATOR_ENABLED, !production);
  const adminToken = blankToUndefined(parsed.ADMIN_TOKEN);
  const simulatorEnabled = production ? simulatorRequested && Boolean(adminToken) : simulatorRequested;
  const slackBotToken = blankToUndefined(parsed.SLACK_BOT_TOKEN);
  const slackAppToken = blankToUndefined(parsed.SLACK_APP_TOKEN);
  const sampleTest = "node test.js";
  const sampleDeploy = `node ${path.join(appRoot, "scripts/publish-staging.mjs")}`;

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    nodeEnv: parsed.NODE_ENV,
    dataDir: path.resolve(parsed.DATA_DIR),
    appRoot,
    projectMode,
    targetRepoPath,
    baseBranch: blankToUndefined(parsed.BASE_BRANCH),
    testCommand: blankToUndefined(parsed.TEST_COMMAND) ?? (projectMode === "sample" ? sampleTest : "npm test"),
    setupCommand: blankToUndefined(parsed.SETUP_COMMAND),
    deployCommand: blankToUndefined(parsed.DEPLOY_COMMAND) ?? (projectMode === "sample" ? sampleDeploy : undefined),
    publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/$/, ""),
    requirePlanApproval: flag(parsed.REQUIRE_PLAN_APPROVAL, true),
    requireDeployApproval: flag(parsed.REQUIRE_DEPLOY_APPROVAL, true),
    testRepairAttempts: parsed.TEST_REPAIR_ATTEMPTS,
    maxBudgetUsd: parsed.CLAUDE_MAX_BUDGET_USD,
    maxTurns: parsed.CLAUDE_MAX_TURNS,
    model: blankToUndefined(parsed.CLAUDE_MODEL),
    anthropicApiKey: apiKey,
    claudeMode,
    phaseTimeoutMs: parsed.CLAUDE_PHASE_TIMEOUT_MS,
    slackBotToken,
    slackAppToken,
    slackSigningSecret: blankToUndefined(parsed.SLACK_SIGNING_SECRET),
    slackEnabled: Boolean(slackBotToken && slackAppToken),
    approverUserIds: (parsed.APPROVER_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    maxJobsPerUserPerHour: parsed.MAX_JOBS_PER_USER_PER_HOUR,
    commandTimeoutMs: parsed.COMMAND_TIMEOUT_MS,
    adminToken,
    simulatorEnabled,
    showTechnicalDetails: flag(parsed.SHOW_TECHNICAL_DETAILS, false),
    logLevel: parsed.LOG_LEVEL,
  };
}
