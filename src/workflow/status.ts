import type { ActionName, Job, Phase } from "../types.js";

const terminal = new Set<Phase>(["done", "failed", "cancelled"]);

export function isTerminal(phase: Phase): boolean {
  return terminal.has(phase);
}

export function stepFor(phase: Phase): { index: number; total: 5; label: string } {
  const table: Record<Phase, [number, string]> = {
    received: [1, "Understanding your request"],
    queued: [1, "Understanding your request"],
    researching: [1, "Understanding your request"],
    clarifying: [1, "Understanding your request"],
    awaiting_plan_approval: [2, "Agreeing the plan"],
    implementing: [3, "Making the change"],
    testing: [4, "Running checks"],
    repairing: [4, "Running checks"],
    awaiting_test_decision: [4, "Running checks"],
    awaiting_deploy_approval: [5, "Publishing to staging"],
    deploying: [5, "Publishing to staging"],
    done: [5, "Publishing to staging"],
    failed: [4, "Running checks"],
    cancelled: [1, "Understanding your request"],
  };
  const [index, label] = table[phase];
  return { index, total: 5, label };
}

export function stepLine(phase: Phase): string {
  const step = stepFor(phase);
  return `Step ${step.index} of ${step.total}: ${step.label}`;
}

export function availableActions(job: Pick<Job, "phase" | "planApproved" | "deployApproved" | "retryRequested">): ActionName[] {
  if (job.phase === "awaiting_plan_approval" && !job.planApproved) {
    return ["approve_plan", "revise", "cancel"];
  }
  if (job.phase === "awaiting_deploy_approval" && !job.deployApproved) {
    return ["approve_deploy", "decline_deploy"];
  }
  if (job.phase === "awaiting_test_decision" && !job.retryRequested) {
    return ["retry", "cancel"];
  }
  if (job.phase === "clarifying") return ["cancel"];
  return [];
}

export function waitingForYou(job: Pick<Job, "phase" | "planApproved" | "deployApproved" | "retryRequested">): boolean {
  return availableActions(job).length > 0;
}

export function badgeFor(job: Pick<Job, "phase" | "outcome" | "planApproved" | "deployApproved" | "retryRequested">): "working" | "needs_you" | "queued" | "done" | "saved" | "stopped" | "failed" {
  if (job.phase === "queued") return "queued";
  if (job.phase === "done" && job.outcome === "saved") return "saved";
  if (job.phase === "done") return "done";
  if (job.phase === "cancelled") return "stopped";
  if (job.phase === "failed") return "failed";
  if (waitingForYou(job)) return "needs_you";
  return "working";
}

const transitions: Record<Phase, Phase[]> = {
  received: ["researching", "queued", "failed", "cancelled"],
  queued: ["researching", "cancelled", "failed"],
  researching: ["clarifying", "awaiting_plan_approval", "failed", "cancelled"],
  clarifying: ["queued", "cancelled", "failed"],
  awaiting_plan_approval: ["implementing", "queued", "cancelled", "failed"],
  implementing: ["testing", "failed", "cancelled"],
  testing: ["repairing", "awaiting_deploy_approval", "awaiting_test_decision", "done", "failed", "cancelled"],
  repairing: ["testing", "failed", "cancelled"],
  awaiting_test_decision: ["repairing", "testing", "failed", "cancelled"],
  awaiting_deploy_approval: ["deploying", "done", "cancelled", "failed"],
  deploying: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function assertTransition(from: Phase, to: Phase): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    throw new Error(`Cannot move from ${from} to ${to}.`);
  }
}

export function phaseLabel(phase: Phase, outcome?: Job["outcome"]): string {
  switch (phase) {
    case "received":
    case "researching":
      return "Reading the project";
    case "queued":
      return "Waiting its turn";
    case "clarifying":
      return "Waiting for a clearer request";
    case "awaiting_plan_approval":
      return "Waiting for you to approve the plan";
    case "implementing":
      return "Making the change";
    case "testing":
      return "Running checks";
    case "repairing":
      return "Fixing the checks";
    case "awaiting_test_decision":
      return "Checks failed, waiting for you";
    case "awaiting_deploy_approval":
      return "Waiting for you to publish to staging";
    case "deploying":
      return "Publishing to staging";
    case "done":
      return outcome === "saved" ? "Saved, staging left as it was" : "Published to staging";
    case "failed":
      return "Stopped because something went wrong";
    case "cancelled":
      return "Stopped";
  }
}
