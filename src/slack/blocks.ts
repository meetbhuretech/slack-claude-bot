import type { ActionName, Job, OutboundMessage } from "../types.js";
import { availableActions, stepLine } from "../workflow/status.js";

const labels: Record<ActionName, string> = {
  approve_plan: "Approve and build",
  revise: "I want a change",
  cancel: "Stop",
  approve_deploy: "Publish to staging",
  decline_deploy: "Leave staging as it is",
  retry: "Try again",
};

const styles: Partial<Record<ActionName, string>> = {
  approve_plan: "primary",
  approve_deploy: "primary",
  cancel: "danger",
};

function chunk(text: string, size = 2800): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [" "];
}

export function renderMessage(job: Job, text: string, replaceStatus: boolean): OutboundMessage {
  const body = `${stepLine(job.phase)}\n${text}`.trim();
  const blocks: Array<Record<string, unknown>> = chunk(body).map((part) => ({
    type: "section",
    text: { type: "mrkdwn", text: part },
  }));
  const actions = replaceStatus ? [] : availableActions(job);
  if (actions.length) {
    blocks.push({
      type: "actions",
      elements: actions.map((action) => ({
        type: "button",
        action_id: action,
        value: job.id,
        text: { type: "plain_text", text: labels[action], emoji: false },
        ...(styles[action] ? { style: styles[action] } : {}),
      })),
    });
  }
  return {
    text: body.replaceAll("\n", " ").slice(0, 3000),
    blocks,
    replaceStatus,
  };
}
