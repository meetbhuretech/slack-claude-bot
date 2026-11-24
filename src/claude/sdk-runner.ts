import type { AppConfig } from "../config.js";
import type { ClaudeRunInput, ClaudeRunResult, ClaudeRunner } from "../types.js";
import { progressLabel } from "./parse.js";

interface SdkMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  message?: { content?: unknown };
}

function assistantText(message: SdkMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: string; text?: string };
      return record.type === "text" ? record.text ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantTool(message: SdkMessage): string | undefined {
  const content = message.message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; name?: string };
    if (record.type === "tool_use" && record.name) return record.name;
  }
  return undefined;
}

function scrubbedEnv(): Record<string, string | undefined> {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"];
  const env: Record<string, string | undefined> = {};
  for (const key of allowed) env[key] = process.env[key];
  env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  return env;
}

function errorCode(subtype: string | undefined): ClaudeRunResult["errorCode"] {
  if (subtype === "error_max_budget_usd") return "budget";
  if (subtype === "error_max_turns") return "turns";
  if (subtype === "error_during_execution") return "execution";
  return "execution";
}

export class SdkClaudeRunner implements ClaudeRunner {
  constructor(private readonly config: AppConfig) {}

  async run(input: ClaudeRunInput): Promise<ClaudeRunResult> {
    if (!this.config.anthropicApiKey) {
      return { ok: false, text: "", errorCode: "config", errorDetail: "Claude is not connected yet." };
    }
    if (input.signal.aborted) return { ok: false, text: "", errorCode: "cancelled" };

    let query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
    try {
      const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
        query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
      };
      query = sdk.query;
    } catch (error) {
      return {
        ok: false,
        text: "",
        errorCode: "config",
        errorDetail: error instanceof Error ? error.message : "Claude Code could not be loaded.",
      };
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (input.signal.aborted) abortController.abort();
    else input.signal.addEventListener("abort", abort, { once: true });

    const readOnly = input.task === "review" || input.task === "research";
    let sessionId: string | undefined;
    let text = "";
    let subtype = "success";
    let isError = false;
    let costUsd: number | undefined;

    try {
      for await (const message of query({
        prompt: input.prompt,
        options: {
          cwd: input.cwd,
          model: input.model || this.config.model,
          maxTurns: input.task === "review" ? 2 : input.maxTurns,
          maxBudgetUsd: input.maxBudgetUsd,
          abortController,
          resume: input.resumeSessionId,
          permissionMode: input.task === "research" ? "plan" : input.task === "review" ? "dontAsk" : "acceptEdits",
          allowedTools: readOnly ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Edit", "Write"],
          disallowedTools: ["Bash", "WebFetch", "WebSearch", "NotebookEdit", "Task"],
          env: scrubbedEnv(),
          persistSession: true,
          extraArgs: {},
        },
      })) {
        if (message.type === "system" && message.subtype === "init" && message.session_id) {
          sessionId = message.session_id;
        }
        if (message.type === "assistant") {
          const tool = assistantTool(message);
          const label = tool ? progressLabel(tool) : undefined;
          if (label) input.onProgress?.(label);
          const chunk = assistantText(message).trim();
          if (chunk) text = chunk;
        }
        if (message.type === "result") {
          sessionId = message.session_id ?? sessionId;
          subtype = message.subtype ?? subtype;
          isError = Boolean(message.is_error);
          if (typeof message.total_cost_usd === "number") costUsd = message.total_cost_usd;
          if (message.subtype === "success" && message.result) text = message.result;
        }
      }
    } catch (error) {
      if (input.signal.aborted || abortController.signal.aborted) {
        return { ok: false, text, sessionId, costUsd, errorCode: "cancelled" };
      }
      if (subtype !== "success") {
        return { ok: false, text, sessionId, costUsd, errorCode: errorCode(subtype), errorDetail: String(error) };
      }
      return {
        ok: false,
        text,
        sessionId,
        costUsd,
        errorCode: "execution",
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
    }

    if (input.signal.aborted) return { ok: false, text, sessionId, costUsd, errorCode: "cancelled" };
    if (subtype !== "success" || isError) {
      return { ok: false, text, sessionId, costUsd, errorCode: errorCode(subtype) };
    }
    return { ok: true, text: text.trim(), sessionId, costUsd };
  }
}
