import type { Job } from "./types.js";
import { phaseLabel, stepLine } from "./workflow/status.js";

export const phrases = {
  ack: () =>
    "Got it. I'll read the project and explain the change in everyday language before I edit anything.",
  queued: () =>
    "I'm finishing another request first. Yours is next, and I'll post the plan here.",
  researching: () => "I'm reading the project now.",
  question: (question: string) =>
    `I want to get this right before I change anything. ${question} Reply here in your own words.`,
  planIntro: () => "Nothing is changed yet. Approve and build when this looks right, or tell me what to adjust.",
  implementing: () => "I'm making the change now. I'll run the checks before anything goes to staging.",
  testsPassed: () => "The checks passed. Should I publish this to the staging site?",
  testsFailed: (summary: string) =>
    `I made the change, but the checks failed, so I left staging as it is. ${summary} You can ask me to try again, or stop here.`,
  deployed: (url: string) =>
    url
      ? `It's on staging. Open it here: ${url}`
      : "It's on staging. The staging update finished.",
  deployFailed: () =>
    "The change is saved, but staging did not update. Staging is still the previous version.",
  savedNotPublished: () => "Saved. I left staging as it was.",
  cancelled: () => "Stopped. I left staging as it was.",
  dirtyRepo: () =>
    "I can't start safely because the project already has unfinished edits. Ask the person who looks after the project to save or set those aside, then send your request again.",
  missingRepo: () =>
    "The project folder is not connected yet. Ask the person who set this up to point me at the project, then send your request again.",
  notARepo: () =>
    "The project folder is not a git project yet, so I can't keep this change separate. Ask the person who looks after it to set that up.",
  missingGit: () => "The project tools are not available on this computer yet. Git needs to be installed.",
  missingClaude: () =>
    "Claude is not connected yet. Ask the person who set this up to add the Claude key. I have not changed the project.",
  emptyRequest: () => "Tell me what you want changed. For example: change the homepage headline to Welcome back.",
  rateLimit: () => "You've sent several requests recently. Please wait a little while, then try again.",
  budget: () => "This request reached its safety limit, so I stopped. I left staging as it was.",
  turns: () => "This request needed more steps than the safety limit allows, so I stopped. I left staging as it was.",
  claudeResearchFailed: () => "I couldn't finish reading the project, so I stopped before making changes.",
  claudeImplementFailed: () => "I couldn't finish the change, so I left staging as it was.",
  noChanges: () => "I looked through the project but didn't end up changing any files, so I left staging as it was.",
  unexpected: () => "Something unexpected went wrong, so I stopped. I left staging as it was. You can send the request again.",
  timedOut: () => "This took too long, so I stopped. I left staging as it was.",
  setupFailed: (summary: string) =>
    `I couldn't prepare the project checks, so I left staging as it was. ${summary}`,
  tooManyRetries: () =>
    "I've tried a few times and the checks still fail. I stopped, and staging stays as it is.",
  wrongStep: () => "That step is already finished.",
  notAllowed: () => "Only the person who asked, or an approver, can confirm this.",
  revisePrompt: () => "Tell me what to adjust, in a reply here.",
  restarted: () =>
    "The assistant restarted before it finished this request. Please send it again. I left staging as it was.",
  slackHelp: () =>
    [
      "Tell me what you want changed, in normal words.",
      "Example: change the homepage headline to Welcome back.",
      "I will read the project, show you a plan, and wait for your OK before I edit anything.",
      "After the checks pass, I will ask again before I publish to staging.",
      "Send /claude and your request, or mention me in a channel.",
      "Send /claude status to see your latest request.",
    ].join(" "),
  noClaudeForSlack: () =>
    "I can practice on the sample page, but Slack requests need a Claude key before I change a project. Ask the person who set this up to add it.",
  sampleSlackBlocked: () =>
    "Slack is connected, but the real project folder is not. Add the project path, or try the practice page on this computer first.",
};

export function describeDiff(stat: string): string {
  const files = stat
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("|") && !line.startsWith("..."))
    .map((line) => line.split("|")[0]?.trim())
    .filter((name): name is string => Boolean(name));

  if (files.length === 0) return "I updated the project.";
  if (files.length === 1 && files[0] === "index.html") return "I updated the homepage.";
  if (files.length === 1) return `I updated ${files[0]}.`;
  return `I updated ${files.length} files.`;
}

export function statusText(job: Job, body: string): string {
  return `${stepLine(job.phase)}\n${body}`;
}

export function latestStatusSentence(job: Job): string {
  const label = phaseLabel(job.phase, job.outcome);
  const detail = job.errorPlain || job.progress || job.planSummary;
  if (!detail || job.phase === "done" || job.phase === "failed" || job.phase === "cancelled") {
    return `${label}.`;
  }
  return `${label}.`;
}
