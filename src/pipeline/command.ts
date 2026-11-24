import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { CommandResult, CommandRunner } from "../types.js";

const secretKey = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|COOKIE|SESSION/i;

export function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (secretKey.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish({ ok: false, output: error.message, timedOut: false }));
    child.on("close", (code) => {
      finish({
        ok: code === 0 && !timedOut && !signal.aborted,
        output: output.trim(),
        timedOut,
      });
    });
  });
}

export class ShellCommandRunner implements CommandRunner {
  constructor(private readonly config: AppConfig) {}

  run(command: string, cwd: string, signal: AbortSignal): Promise<CommandResult> {
    const env = scrubEnv(process.env);
    env.DATA_DIR = this.config.dataDir;
    env.PUBLIC_BASE_URL = this.config.publicBaseUrl;
    return runShell(command, cwd, env, this.config.commandTimeoutMs, signal);
  }
}
