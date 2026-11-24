import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { toPublicJob } from "./public-job.js";
import { renderPage } from "./page.js";
import type { Orchestrator } from "../workflow/orchestrator.js";
import { JobStore } from "../store/jobs.js";
import type { Logger } from "../types.js";

export interface HttpRuntime {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

interface ServerDeps {
  config: AppConfig;
  orchestrator: Orchestrator;
  store: JobStore;
  logger: Logger;
  projectName: string;
  projectReady: () => Promise<boolean>;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": type === "application/json" ? "application/json; charset=utf-8" : type,
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request must be an object.");
  return parsed as Record<string, unknown>;
}

function authorized(config: AppConfig, req: IncomingMessage): boolean {
  if (!config.adminToken) return config.nodeEnv !== "production";
  return req.headers["x-admin-token"] === config.adminToken;
}

export function startHttp(deps: ServerDeps): Promise<HttpRuntime> {
  const { config, orchestrator, store, logger, projectName, projectReady } = deps;
  const stagingDir = path.resolve(config.dataDir, "staging");
  const page = renderPage({
    projectMode: config.projectMode,
    projectName,
    claudeMode: config.claudeMode,
    slackEnabled: config.slackEnabled,
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname === "/ready") {
        const ready = await projectReady();
        send(res, ready ? 200 : 503, {
          ok: ready,
          projectMode: config.projectMode,
          claudeMode: config.claudeMode,
          slack: config.slackEnabled,
        });
        return;
      }
      if (method === "GET" && (url.pathname === "/staging" || url.pathname === "/staging/")) {
        send(res, 200, readStaging(stagingDir, "index.html"), "text/html; charset=utf-8");
        return;
      }
      if (method === "GET" && url.pathname === "/staging/styles.css") {
        send(res, 200, readStaging(stagingDir, "styles.css"), "text/css; charset=utf-8");
        return;
      }
      if (!config.simulatorEnabled) {
        if (method === "GET" && url.pathname === "/") {
          send(res, 200, "Project assistant is running.", "text/plain; charset=utf-8");
          return;
        }
        send(res, 404, { message: "Not found." });
        return;
      }
      if (!authorized(config, req) && url.pathname.startsWith("/api/")) {
        send(res, 401, { message: "This practice page needs the admin token." });
        return;
      }
      if (method === "GET" && url.pathname === "/") {
        send(res, 200, page, "text/html; charset=utf-8");
        return;
      }
      if (method === "GET" && url.pathname === "/api/meta") {
        send(res, 200, {
          projectMode: config.projectMode,
          projectName,
          claudeMode: config.claudeMode,
          slackEnabled: config.slackEnabled,
        });
        return;
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/(job_[a-f0-9]+)(?:\/([a-z-]+))?$/);
      if (method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJson(req);
        const text = String(body.text ?? "");
        const userId = String(body.userId ?? "local-user");
        const result = await orchestrator.start(
          {
            channelId: "practice",
            threadTs: `practice-${randomUUID()}`,
            userId,
            source: "simulator",
            text,
          },
          { wait: false },
        );
        if (!result.accepted) {
          send(res, 400, { message: result.message });
          return;
        }
        send(res, 202, { job: toPublicJob(store.must(result.job.id)) });
        return;
      }
      if (jobMatch && method === "GET" && !jobMatch[2]) {
        const job = store.get(jobMatch[1]);
        if (!job) {
          send(res, 404, { message: "That request was not found." });
          return;
        }
        send(res, 200, { job: toPublicJob(job) });
        return;
      }
      if (jobMatch && method === "POST" && jobMatch[2]) {
        const id = jobMatch[1];
        const action = jobMatch[2];
        const current = store.get(id);
        if (!current) {
          send(res, 404, { message: "That request was not found." });
          return;
        }
        const userId = current.userId;
        const body = action === "revise" ? await readJson(req) : {};
        const result = await runAction(orchestrator, action, current, userId, String(body.text ?? ""));
        if (!result) {
          send(res, 404, { message: "That action is not available." });
          return;
        }
        if (!result.ok) {
          send(res, 409, { message: result.message ?? "That step is already finished.", job: toPublicJob(store.get(id) ?? result.job) });
          return;
        }
        send(res, 200, { job: toPublicJob(store.must(id)) });
        return;
      }
      send(res, 404, { message: "Not found." });
    } catch (error) {
      logger.error("http request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) send(res, 400, { message: "That request could not be read." });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function readStaging(stagingDir: string, name: "index.html" | "styles.css"): string {
  const file = path.join(stagingDir, name);
  if (!existsSync(file)) {
    return name.endsWith(".css")
      ? ""
      : "<!doctype html><title>Staging</title><p>Nothing has been published to staging yet.</p>";
  }
  return readFileSync(file, "utf8");
}

async function runAction(
  orchestrator: Orchestrator,
  action: string,
  job: { id: string; channelId: string; threadTs: string; userId: string },
  userId: string,
  text: string,
) {
  if (action === "approve-plan") return orchestrator.approvePlan(job.id, userId, { wait: false });
  if (action === "approve-deploy") return orchestrator.approveDeploy(job.id, userId, { wait: false });
  if (action === "decline-deploy") return orchestrator.declineDeploy(job.id, userId);
  if (action === "retry") return orchestrator.retry(job.id, userId, { wait: false });
  if (action === "cancel") return orchestrator.cancel(job.id, userId);
  if (action === "revise") {
    const changed = await orchestrator.requestChange(job.id, userId);
    if (!changed.ok || !text.trim()) return changed;
    const follow = await orchestrator.reply(job.channelId, job.threadTs, userId, text, { wait: false });
    if (!follow.accepted) return { ok: false, message: follow.message, job: changed.job };
    return { ok: true, job: follow.job };
  }
  return undefined;
}
