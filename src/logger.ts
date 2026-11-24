import type { Logger } from "./types.js";

const ranks = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: keyof typeof ranks = "info"): Logger {
  function write(kind: keyof typeof ranks, message: string, extra?: Record<string, unknown>) {
    if (ranks[kind] < ranks[level]) return;
    const line = {
      time: new Date().toISOString(),
      level: kind,
      message,
      ...extra,
    };
    const stream = kind === "error" || kind === "warn" ? console.error : console.log;
    stream(JSON.stringify(line));
  }

  return {
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

export function silentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
