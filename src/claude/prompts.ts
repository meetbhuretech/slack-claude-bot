export function reviewPrompt(request: string): string {
  return [
    "You review a change request from a teammate who may not be technical.",
    "Do not read files. Do not change anything. Do not suggest commands.",
    "Reply with JSON only, no markdown:",
    '{"understood":"","needsClarification":false,"question":""}',
    "understood is one sentence in everyday words.",
    "Set needsClarification to true only when you cannot tell what should change.",
    "Greetings, help requests, and messages that name no change need clarification.",
    "question is one friendly question, or an empty string.",
    "",
    "Their message:",
    "---",
    request,
    "---",
  ].join("\n");
}

export function researchPrompt(request: string, understood: string): string {
  return [
    "Plan a software change for a non-technical teammate.",
    "Read this repository before you answer.",
    "Do not edit files, run commands, push, or deploy.",
    "Write plain language with exactly these headings:",
    "What you asked for",
    "What I will change",
    "What I will leave alone",
    "How I will check it",
    "Keep it short enough to read on a phone.",
    "Do not mention tools, models, branches, or internal steps.",
    "",
    `What you understood: ${understood || "See their request."}`,
    "",
    "Their request:",
    "---",
    request,
    "---",
  ].join("\n");
}

export function implementPrompt(request: string, plan: string): string {
  return [
    "Make the approved change in this repository.",
    "Do not push, deploy, switch branches, or change git settings.",
    "When you finish, reply with a short everyday summary under 80 words.",
    "",
    "Approved plan:",
    plan,
    "",
    "Original request:",
    request,
  ].join("\n");
}

export function repairPrompt(request: string, plan: string, output: string): string {
  return [
    "The project checks failed. Fix the project so they pass.",
    "Do not push or deploy.",
    "Then reply with a short everyday summary of the fix.",
    "",
    "Request:",
    request,
    "",
    "Plan:",
    plan,
    "",
    "Check output:",
    output.slice(-4000),
  ].join("\n");
}
