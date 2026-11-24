import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { phrases } from "../copy.js";
import { UserFacingError, type PreparedWorkspace, type Workspace } from "../types.js";

const exec = promisify(execFile);

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { maxBuffer: 4_000_000 });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (failure.code === "ENOENT") throw new UserFacingError(phrases.missingGit());
    const detail = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim();
    const wrapped = new Error(detail || "git failed");
    (wrapped as Error & { gitArgs?: string[] }).gitArgs = args;
    throw wrapped;
  }
}

function isMissingRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a git repository|unknown revision|ambiguous argument/i.test(message);
}

export class GitWorkspace implements Workspace {
  constructor(private readonly dataDir: string) {}

  async assertReady(repoPath: string): Promise<void> {
    try {
      const inside = await git(["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
      if (inside.trim() !== "true") throw new UserFacingError(phrases.notARepo());
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (isMissingRepo(error)) throw new UserFacingError(phrases.notARepo());
      throw error;
    }
    const dirty = await git(["-C", repoPath, "status", "--porcelain"]);
    if (dirty.trim()) throw new UserFacingError(phrases.dirtyRepo());
  }

  async prepare(repoPath: string, jobId: string, slug: string, baseBranch?: string): Promise<PreparedWorkspace> {
    await this.assertReady(repoPath);
    const branch = `slack/${jobId}-${slug}`;
    const worktree = path.join(this.dataDir, "worktrees", jobId);
    mkdirSync(path.dirname(worktree), { recursive: true });
    rmSync(worktree, { recursive: true, force: true });
    const base = baseBranch?.trim() || "HEAD";
    await git(["-C", repoPath, "worktree", "add", "-b", branch, worktree, base]);
    return { branch, path: worktree };
  }

  async diffStat(worktreePath: string): Promise<string> {
    return (await git(["-C", worktreePath, "show", "--stat", "--format=", "HEAD"])).trim();
  }

  async commit(worktreePath: string, message: string): Promise<string | null> {
    const dirty = await git(["-C", worktreePath, "status", "--porcelain"]);
    if (!dirty.trim()) return null;
    await git(["-C", worktreePath, "add", "-A"]);
    await git([
      "-C",
      worktreePath,
      "-c",
      "user.name=Project Assistant",
      "-c",
      "user.email=assistant@localhost",
      "commit",
      "-m",
      message,
    ]);
    return (await git(["-C", worktreePath, "rev-parse", "--short", "HEAD"])).trim();
  }

  async release(repoPath: string, worktreePath: string): Promise<void> {
    await this.remove(repoPath, worktreePath, "");
  }

  async remove(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    if (worktreePath) {
      try {
        await git(["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          await git(["-C", repoPath, "worktree", "prune"]);
        } catch {
          // The branch cleanup below is the part that matters.
        }
      }
    }
    if (branch) {
      try {
        await git(["-C", repoPath, "branch", "-D", branch]);
      } catch {
        // The branch may already be gone after a failed prepare.
      }
    }
  }
}
