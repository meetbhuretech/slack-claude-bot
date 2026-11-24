import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { AppConfig } from "../config.js";
import { phrases } from "../copy.js";
import { phaseLabel } from "../workflow/status.js";
import type { Orchestrator } from "../workflow/orchestrator.js";
import { JobStore } from "../store/jobs.js";
import type { Job, Logger, Notifier, OutboundMessage } from "../types.js";

class SlackNotifier implements Notifier {
  constructor(
    private readonly app: App,
    private readonly store: JobStore,
    private readonly logger: Logger,
  ) {}

  async notify(job: Job, message: OutboundMessage): Promise<void> {
    if (!job.channelId || job.channelId === "practice") return;
    try {
      if (message.replaceStatus && job.slackStatusTs) {
        await this.app.client.chat.update({
          channel: job.channelId,
          ts: job.slackStatusTs,
          text: message.text,
          blocks: message.blocks as unknown as KnownBlock[],
        });
        return;
      }
      const posted = await this.app.client.chat.postMessage({
        channel: job.channelId,
        thread_ts: job.threadTs || undefined,
        text: message.text,
        blocks: message.blocks as unknown as KnownBlock[],
      });
      if (message.replaceStatus && posted.ts) this.store.update(job.id, { slackStatusTs: posted.ts });
    } catch (error) {
      this.logger.error("Slack could not post an update", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function clean(text: string | undefined): string {
  return (text ?? "").replace(/<@[^>]+>/g, "").trim();
}

export async function startSlack(options: {
  config: AppConfig;
  orchestrator: Orchestrator;
  store: JobStore;
  logger: Logger;
}): Promise<{ notifier: Notifier; close: () => Promise<void> }> {
  const { config, orchestrator, store, logger } = options;
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id ?? "";
  const notifier = new SlackNotifier(app, store, logger);

  async function handleText(args: {
    channel: string;
    threadTs: string;
    userId: string;
    text: string;
    eventId?: string;
    inThread: boolean;
  }): Promise<void> {
    if (config.projectMode !== "repo") {
      await app.client.chat.postMessage({ channel: args.channel, thread_ts: args.threadTs, text: phrases.sampleSlackBlocked() });
      return;
    }
    if (config.claudeMode !== "live") {
      await app.client.chat.postMessage({ channel: args.channel, thread_ts: args.threadTs, text: phrases.noClaudeForSlack() });
      return;
    }
    const normalized = args.text.trim().toLowerCase();
    if (!args.text || normalized === "help") {
      await app.client.chat.postMessage({ channel: args.channel, thread_ts: args.threadTs, text: phrases.slackHelp() });
      return;
    }
    if (normalized === "status") {
      const latest = store.latestForUser(args.userId);
      const text = latest
        ? `Your latest request is “${latest.requestText}”. ${phaseLabel(latest.phase, latest.outcome)}.`
        : "You don't have a request yet. Tell me what you want changed.";
      await app.client.chat.postMessage({ channel: args.channel, thread_ts: args.threadTs, text });
      return;
    }
    if (args.inThread) {
      const existing = store.findByThread(args.channel, args.threadTs);
      if (existing) {
        const result = await orchestrator.reply(args.channel, args.threadTs, args.userId, args.text, { wait: false });
        if (!result.accepted) {
          await app.client.chat.postMessage({ channel: args.channel, thread_ts: args.threadTs, text: result.message });
        }
        return;
      }
    }
    await orchestrator.start(
      {
        channelId: args.channel,
        threadTs: args.threadTs,
        userId: args.userId,
        source: "slack",
        text: args.text,
        eventId: args.eventId,
      },
      { wait: false },
    );
  }

  app.event("app_mention", async ({ event, body }) => {
    const text = clean(event.text);
    await handleText({
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user ?? "",
      text,
      eventId: "event_id" in body ? String(body.event_id) : undefined,
      inThread: Boolean(event.thread_ts),
    });
  });

  app.event("app_home_opened", async ({ event, client }) => {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Project assistant", emoji: false } },
          { type: "section", text: { type: "mrkdwn", text: phrases.slackHelp() } },
        ],
      },
    });
  });

  app.message(async ({ message, body }) => {
    if (!("user" in message) || !("text" in message) || message.subtype || ("bot_id" in message && message.bot_id)) return;
    const raw = message.text ?? "";
    if (botUserId && raw.includes(`<@${botUserId}>`)) return;
    const text = clean(raw);
    const channel = message.channel;
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
    const channelType = "channel_type" in message ? message.channel_type : undefined;
    const inThread = Boolean(threadTs);
    if (channelType !== "im" && !inThread) return;
    if (inThread && channelType !== "im" && !store.findByThread(channel, threadTs ?? "")) return;
    await handleText({
      channel,
      threadTs: threadTs ?? message.ts,
      userId: message.user ?? "",
      text,
      eventId: "event_id" in body ? String(body.event_id) : undefined,
      inThread,
    });
  });

  for (const commandName of ["/project", "/claude"]) {
    app.command(commandName, async ({ ack, command }) => {
      await ack();
      const text = clean(command.text);
      const root = await app.client.chat.postMessage({
        channel: command.channel_id,
        text: text ? `Request: ${text}` : "How can I help?",
      });
      await handleText({
        channel: command.channel_id,
        threadTs: root.ts ?? command.trigger_id,
        userId: command.user_id,
        text,
        eventId: command.trigger_id,
        inThread: false,
      });
    });
  }

  const actionMap: Record<string, (id: string, userId: string) => Promise<{ ok: boolean; message?: string; job: { channelId: string; threadTs: string } }>> = {
    approve_plan: (id, userId) => orchestrator.approvePlan(id, userId, { wait: false }),
    revise: (id, userId) => orchestrator.requestChange(id, userId),
    cancel: (id, userId) => orchestrator.cancel(id, userId),
    approve_deploy: (id, userId) => orchestrator.approveDeploy(id, userId, { wait: false }),
    decline_deploy: (id, userId) => orchestrator.declineDeploy(id, userId),
    retry: (id, userId) => orchestrator.retry(id, userId, { wait: false }),
  };

  for (const [actionId, run] of Object.entries(actionMap)) {
    app.action(actionId, async ({ ack, body, action, client }) => {
      await ack();
      const jobId = "value" in action ? action.value : undefined;
      const userId = body.user.id;
      if (!jobId) return;
      const result = await run(jobId, userId);
      if (!result.ok && result.message && result.job.channelId && result.job.channelId !== "practice") {
        await client.chat.postMessage({
          channel: result.job.channelId,
          thread_ts: result.job.threadTs || undefined,
          text: result.message,
        });
      }
    });
  }

  app.error(async (error) => {
    logger.error("Slack listener failed", { error: error.message });
  });

  await app.start();
  logger.info("Slack is connected");
  return {
    notifier,
    close: async () => {
      await app.stop();
    },
  };
}
