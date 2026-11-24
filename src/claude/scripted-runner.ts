import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeRunInput, ClaudeRunResult, ClaudeRunner } from "../types.js";
import { escapeHtml, headlineFrom } from "../text.js";

function planFor(request: string): string {
  const headline = headlineFrom(request);
  return [
    "What you asked for",
    request,
    "",
    "What I will change",
    `The homepage headline will become “${headline}”.`,
    "",
    "What I will leave alone",
    "The rest of the page stays as it is.",
    "",
    "How I will check it",
    "I will run the project's checks, then ask you before anything goes to staging.",
  ].join("\n");
}

function needsClarification(request: string): boolean {
  const trimmed = request.trim();
  if (trimmed.length < 12) return true;
  return /^(hi|hello|hey|help|test|thanks|thank you)[.!]?$/i.test(trimmed);
}

/**
 * Practice runner used when no Claude key is configured.
 * It only changes a sample homepage headline, so it can demonstrate the full
 * approval flow without calling Claude.
 */
export class ScriptedClaudeRunner implements ClaudeRunner {
  async run(input: ClaudeRunInput): Promise<ClaudeRunResult> {
    if (input.signal.aborted) {
      return { ok: false, text: "", errorCode: "cancelled" };
    }
    const request = input.requestText.trim();
    if (input.task === "review") {
      if (needsClarification(request)) {
        return {
          ok: true,
          text: JSON.stringify({
            understood: "",
            needsClarification: true,
            question: "What would you like me to change? For example: change the homepage headline to Welcome back.",
          }),
          sessionId: "scripted-review",
        };
      }
      return {
        ok: true,
        text: JSON.stringify({
          understood: `You want the homepage headline to say “${headlineFrom(request)}”.`,
          needsClarification: false,
          question: "",
        }),
        sessionId: "scripted-review",
      };
    }

    if (input.task === "research") {
      input.onProgress?.("Reading the project");
      return { ok: true, text: planFor(request), sessionId: "scripted-research" };
    }

    const headline = headlineFrom(request);
    const htmlPath = path.join(input.cwd, "index.html");
    const html = readFileSync(htmlPath, "utf8");
    const next = html.includes("<h1>")
      ? html.replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${escapeHtml(headline)}</h1>`)
      : html.replace("</body>", `  <h1>${escapeHtml(headline)}</h1>\n</body>`);
    writeFileSync(htmlPath, next);
    input.onProgress?.("Updating the project");
    return {
      ok: true,
      text: `I changed the homepage headline to “${headline}”.`,
      sessionId: input.resumeSessionId || "scripted-edit",
    };
  }
}

export class UnavailableClaudeRunner implements ClaudeRunner {
  constructor(private readonly message: string) {}

  async run(): Promise<ClaudeRunResult> {
    return { ok: false, text: "", errorCode: "config", errorDetail: this.message };
  }
}
