export function renderPage(meta: {
  projectMode: "sample" | "repo";
  projectName: string;
  claudeMode: "scripted" | "live";
  slackEnabled: boolean;
}): string {
  const payload = JSON.stringify(meta).replaceAll("<", "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Project assistant</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17211c;
      --muted: #5d6b64;
      --paper: #f3f6f4;
      --card: #ffffff;
      --line: #d7e2dc;
      --accent: #0e6b52;
      --accent-ink: #ffffff;
      --warn: #8a5a12;
      --warn-bg: #fff6e8;
      --bad: #8d2f39;
      --bad-bg: #fff0f1;
      --good: #0e6b52;
      --good-bg: #e8f6f0;
      --shadow: 0 12px 40px rgba(23, 33, 28, 0.06);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #e5f4ee, transparent 36%),
        var(--paper);
    }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
    h1 { font-family: Georgia, "Iowan Old Style", serif; font-size: 2.4rem; line-height: 1.1; margin: 0 0 8px; font-weight: 600; }
    .lede { color: var(--muted); font-size: 1.05rem; line-height: 1.5; margin: 0 0 20px; }
    .banner, .card, form { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
    .banner { padding: 14px 16px; margin-bottom: 16px; background: var(--warn-bg); color: var(--warn); }
    form, .card { padding: 16px; margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    textarea {
      width: 100%; min-height: 96px; resize: vertical; border-radius: 12px;
      border: 1px solid var(--line); padding: 12px; font: inherit; color: inherit;
    }
    textarea:focus { outline: 3px solid #b7e0d2; border-color: var(--accent); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    button, .link {
      border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; cursor: pointer;
      background: #e7eeea; color: var(--ink);
    }
    button.primary, .link { background: var(--accent); color: var(--accent-ink); text-decoration: none; display: inline-block; }
    button.danger { background: var(--bad-bg); color: var(--bad); }
    button:disabled { opacity: 0.6; cursor: progress; }
    .steps { display: flex; gap: 8px; list-style: none; padding: 0; margin: 0 0 16px; flex-wrap: wrap; }
    .steps li { padding: 6px 10px; border-radius: 999px; background: #e7eeea; color: var(--muted); font-size: 0.85rem; }
    .steps li.current { background: var(--accent); color: white; }
    .steps li.done { background: var(--good-bg); color: var(--good); }
    .badge { display: inline-block; margin-bottom: 8px; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.02em; }
    .message { padding: 12px 0; border-top: 1px solid var(--line); white-space: pre-wrap; line-height: 1.45; }
    .message:first-child { border-top: 0; }
    .progress { color: var(--muted); }
    .preview { width: 100%; height: 280px; border: 1px solid var(--line); border-radius: 12px; background: white; }
    .hidden { display: none; }
    .error { color: var(--bad); }
  </style>
</head>
<body>
  <main>
    <h1>Project assistant</h1>
    <p class="lede">Describe a change the way you would say it to a teammate. I'll read the project, show the plan, make the change, run the checks, and publish to staging only after you say so.</p>
    <div id="banner" class="banner hidden"></div>
    <form id="request-form">
      <label for="request">What should change?</label>
      <textarea id="request" name="request" maxlength="2000" placeholder="Change the homepage headline to Hello from the team"></textarea>
      <div class="row">
        <button class="primary" type="submit">Send</button>
      </div>
      <p id="form-error" class="error" role="alert"></p>
    </form>
    <section id="job" class="card hidden" aria-live="polite">
      <div id="badge" class="badge"></div>
      <ol id="steps" class="steps"></ol>
      <div id="transcript"></div>
      <p id="progress" class="progress"></p>
      <div id="actions" class="row"></div>
      <div id="preview-wrap" class="hidden">
        <p><a id="preview-link" class="link" href="" target="_blank" rel="noreferrer">Open the staging page</a></p>
        <iframe id="preview" class="preview" title="Staging preview"></iframe>
      </div>
    </section>
  </main>
  <script>
    const meta = ${payload};
    const banner = document.querySelector("#banner");
    if (meta.projectMode === "sample") {
      banner.classList.remove("hidden");
      banner.textContent = meta.claudeMode === "live"
        ? "Practice mode is using the sample website. Staging on this computer updates after you approve. Slack uses the same flow once a project folder is connected."
        : "Practice mode is on. I can change the sample homepage headline, run its checks, and publish the result to a staging page on this computer. Connecting a Claude key lets the same flow edit a real project.";
    }
    const form = document.querySelector("#request-form");
    const requestField = document.querySelector("#request");
    const formError = document.querySelector("#form-error");
    const jobCard = document.querySelector("#job");
    const badge = document.querySelector("#badge");
    const steps = document.querySelector("#steps");
    const transcript = document.querySelector("#transcript");
    const progress = document.querySelector("#progress");
    const actions = document.querySelector("#actions");
    const previewWrap = document.querySelector("#preview-wrap");
    const preview = document.querySelector("#preview");
    const previewLink = document.querySelector("#preview-link");
    const labels = {
      approve_plan: "Approve and build",
      revise: "I want a change",
      cancel: "Stop",
      approve_deploy: "Publish to staging",
      decline_deploy: "Leave staging as it is",
      retry: "Try again"
    };
    const badgeText = {
      working: "Working",
      needs_you: "Waiting for you",
      queued: "Waiting its turn",
      done: "On staging",
      saved: "Saved",
      stopped: "Stopped",
      failed: "Stopped"
    };
    let timer = 0;
    function render(job) {
      jobCard.classList.remove("hidden");
      badge.textContent = badgeText[job.badge] || "Working";
      steps.innerHTML = "";
      for (let index = 1; index <= job.step.total; index += 1) {
        const item = document.createElement("li");
        item.textContent = index + ". " + ["Understand", "Plan", "Build", "Check", "Staging"][index - 1];
        if (index < job.step.index) item.className = "done";
        if (index === job.step.index) item.className = "current";
        steps.appendChild(item);
      }
      transcript.innerHTML = "";
      for (const entry of job.transcript) {
        const p = document.createElement("p");
        p.className = "message";
        p.textContent = entry.text;
        transcript.appendChild(p);
      }
      progress.textContent = job.progress || "";
      actions.innerHTML = "";
      for (const action of job.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = labels[action];
        if (action === "approve_plan" || action === "approve_deploy") button.className = "primary";
        if (action === "cancel") button.className = "danger";
        button.addEventListener("click", () => act(job.id, action, button));
        actions.appendChild(button);
      }
      if (job.deployUrl) {
        previewWrap.classList.remove("hidden");
        previewLink.href = job.deployUrl;
        preview.src = job.deployUrl;
      } else {
        previewWrap.classList.add("hidden");
      }
      const waiting = ["needs_you", "done", "saved", "stopped", "failed"].includes(job.badge);
      if (!waiting) schedule(job.id);
    }
    async function load(id) {
      const response = await fetch("/api/jobs/" + id);
      if (!response.ok) {
        localStorage.removeItem("project-assistant-job");
        return;
      }
      const body = await response.json();
      render(body.job);
    }
    function schedule(id) {
      clearTimeout(timer);
      timer = setTimeout(() => load(id), 700);
    }
    async function act(id, action, button) {
      const paths = {
        approve_plan: "approve-plan",
        revise: "revise",
        cancel: "cancel",
        approve_deploy: "approve-deploy",
        decline_deploy: "decline-deploy",
        retry: "retry"
      };
      button.disabled = true;
      let text = "";
      if (action === "revise") {
        text = window.prompt("What should I adjust?") || "";
        if (!text.trim()) {
          button.disabled = false;
          return;
        }
      }
      const response = await fetch("/api/jobs/" + id + "/" + paths[action], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      });
      const body = await response.json();
      if (!response.ok) {
        formError.textContent = body.message || "That did not work. Please try again.";
        button.disabled = false;
        return;
      }
      render(body.job);
      schedule(id);
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      formError.textContent = "";
      const text = requestField.value.trim();
      if (!text) {
        formError.textContent = "Tell me what you want changed.";
        return;
      }
      const submit = form.querySelector("button");
      submit.disabled = true;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, userId: "local-user" })
      });
      const body = await response.json();
      submit.disabled = false;
      if (!response.ok) {
        formError.textContent = body.message || "That did not work. Please try again.";
        return;
      }
      localStorage.setItem("project-assistant-job", body.job.id);
      requestField.value = "";
      render(body.job);
      schedule(body.job.id);
    });
    const saved = localStorage.getItem("project-assistant-job");
    if (saved) load(saved);
  </script>
</body>
</html>`;
}
