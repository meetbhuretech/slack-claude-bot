# Project assistant

A teammate types a change in ordinary language. The assistant reads the project, explains the plan, makes the change on its own branch, runs the checks, and publishes to staging only after a person says so.

People do this from Slack. The same flow can be practiced on this computer before Slack is connected.

## What a teammate does

1. Invite **Project Assistant** to a channel, or open a direct message with it.
2. Say what should change. Mention the bot in a channel, or type `/project` followed by the request.

   Example: `change the homepage headline to Welcome back`

3. Read the plan. It is written in everyday language.
4. Tap **Approve and build** when the plan is right. Tap **I want a change** to adjust it, or **Stop** to leave the project as it is.
5. When the checks pass, tap **Publish to staging**. The link comes back in the thread.
6. Tap **Leave staging as it is** if the change should stay saved and staging should stay on the previous version.

The assistant posts each step in the same thread: reading the project, the plan, the checks, and the staging link. The site people already use is not part of this flow. Only staging is updated, and only after the second approval.

If a message is too vague, the assistant asks one question and waits for a reply in the thread.

## Try it on this computer

This uses a sample website, so nothing of yours is changed.

```bash
nvm use 22
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Send: `Change the homepage headline to Hello from the team`

Approve the plan, then publish to staging. The page shows the staging result underneath the conversation. The original sample headline stays “Welcome” until a request is published.

`npm run demo` runs that same sample request in the terminal and prints each message.

## Connect Slack

Do this once. After it is connected, teammates only use the steps above.

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) and choose **From a manifest**. Paste `slack-app-manifest.json`.
2. Install the app to the workspace.
3. Turn on **Socket Mode**. Create an app-level token with the scope `connections:write`. It starts with `xapp-`.
4. Copy the bot token. It starts with `xoxb-`.
5. Copy `.env.example` to `.env` and fill in:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
TARGET_REPO_PATH=/full/path/to/the/git/project
PUBLIC_BASE_URL=https://your-assistant-host.example
TEST_COMMAND=npm test
DEPLOY_COMMAND=npm run deploy:staging
```

6. Start it with `npm run dev` on a machine that can see the project folder, or use the server steps below.

`DEPLOY_COMMAND` runs inside the approved change and should print the staging link as its last line. The assistant passes `DATA_DIR` and `PUBLIC_BASE_URL` to that command. It does not pass Slack tokens or the Claude key.

`SETUP_COMMAND` is optional. Use it when the checks need an install first, for example `npm ci`.

Leave `REQUIRE_PLAN_APPROVAL` and `REQUIRE_DEPLOY_APPROVAL` on. Those two taps are how a non-technical person stays in control.

`APPROVER_USER_IDS` is optional. When it is empty, anyone in the channel can approve. When it lists Slack member IDs, only those people and the person who asked can approve.

## What the assistant will and will not do

Each request goes through five steps:

1. Understand the message. Short greetings get a question instead of a guess.
2. Read the project and write a plan. This step cannot edit files.
3. After approval, make the change on a new branch named `slack/job-...`. The current branch is left as it is.
4. Run `TEST_COMMAND`. If the checks fail, it gets one chance to fix them, then it stops and asks. Staging is left as it is.
5. After a second approval, run `DEPLOY_COMMAND`.

Safety built into every request:

- A request is refused when the project has uncommitted edits, so someone else's work is not mixed in.
- Claude can read and edit the project. It cannot run shell commands, browse the web, push, or deploy. Checks and staging are the commands you configured.
- Slack tokens and API keys are removed from the environment those commands see.
- One request is worked on at a time. The next person is told they are next.
- Each person can start 8 requests an hour. Change that with `MAX_JOBS_PER_USER_PER_HOUR`.
- A request stops if it costs more than `CLAUDE_MAX_BUDGET_USD` or runs longer than `CLAUDE_PHASE_TIMEOUT_MS`.
- Restarting the process marks an in-progress request as stopped and posts that nothing was published. Approved work that was waiting can continue.
- Duplicate Slack deliveries are ignored.

Practice mode, with no Claude key and no `TARGET_REPO_PATH`, only changes the sample homepage headline. It will not edit a real repository. Slack requests are refused until both the project path and the Claude key are set.

## Run it on a server

The process is one Node.js 22 service. Slack uses Socket Mode, so the server does not need a public Slack request URL. Port 3000 is the health check and, in development, the practice page.

Docker:

```bash
docker compose up --build
```

`TARGET_REPO_PATH` on the host is mounted at `/repo`. Set that same value in `.env` before composing, and set `TARGET_REPO_PATH=/repo` inside the container. The compose file does the container half.

Fly.io: `fly.toml` keeps one machine running and stores jobs on a volume at `/data`. Set the tokens and the deploy command with `fly secrets set`. The machine must be able to reach the git project you want people to change. A single machine is required because the job queue and the project checkout live on that machine.

Health: `GET /health` returns `{ "ok": true }`. `GET /ready` reports whether the project folder is a clean git checkout.

In production the practice page stays off unless `SIMULATOR_ENABLED=true` and `ADMIN_TOKEN` are both set. Send the token in the `x-admin-token` header.

## Checks

```bash
nvm use 22
npm test
npm run typecheck
```

The tests cover the real sequence: plan, approval, edit on a separate branch, passing checks, staging publish, failed checks, a vague request, a dirty project, declining staging, and a duplicate Slack event. They also drive the practice page and confirm the sample homepage itself stays unchanged until staging is published.

## When something goes wrong

| What people see | What to do |
| --- | --- |
| The project folder is not connected | Set `TARGET_REPO_PATH` to a git checkout and restart. |
| Claude is not connected | Set `ANTHROPIC_API_KEY`. Practice mode still works without it. |
| The project already has unfinished edits | Commit or set aside those edits, then send the request again. |
| The checks failed | Read the short reason in the thread. Tap **Try again**, or **Stop**. |
| Staging did not update | The change is still on its `slack/job-...` branch. Fix `DEPLOY_COMMAND` and publish that branch the way you usually do. |
| Slack is quiet | Confirm Socket Mode is on, both tokens are in `.env`, and the app is installed in the channel. |
