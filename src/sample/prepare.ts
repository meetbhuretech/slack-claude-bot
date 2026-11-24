import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appRoot, type AppConfig } from "../config.js";

const exec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await exec("git", ["-C", repo, ...args]);
}

export function sampleTemplateDir(): string {
  return path.join(appRoot, "examples", "sample-site");
}

export async function prepareSampleRepo(config: AppConfig): Promise<string> {
  const repo = path.join(config.dataDir, "sample-repo");
  if (existsSync(path.join(repo, ".git"))) return repo;
  mkdirSync(repo, { recursive: true });
  cpSync(sampleTemplateDir(), repo, { recursive: true });
  try {
    await git(repo, ["init", "-b", "main"]);
  } catch {
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
  }
  await git(repo, ["add", "-A"]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Project Assistant",
    "-c",
    "user.email=assistant@localhost",
    "commit",
    "-m",
    "Initial sample site",
  ]);
  return repo;
}
