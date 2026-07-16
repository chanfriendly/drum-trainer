/**
 * Minimal logger — replaces `@glaze/core/backend`'s `logger`.
 *
 * Writes to a file under userData/logs/, not just stdout. Per CLAUDE.md →
 * Principles (context hygiene): Electron main output, Vite, and the renderer
 * console together will flood a session, so diagnostics go somewhere greppable.
 * Console output is kept only in dev, where it is actually watched.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { app } from "electron";

type Level = "debug" | "info" | "warn" | "error";

const isDev = !app.isPackaged;

let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, "main.log"), { flags: "a" });
    return stream;
  } catch {
    // Logging must never take the app down.
    return null;
  }
}

function write(level: Level, scope: string, message: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${
    data === undefined ? "" : ` ${safeStringify(data)}`
  }`;

  getStream()?.write(`${line}\n`);

  if (isDev || level === "error") {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line);
  }
}

function safeStringify(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) => write("debug", scope, message, data),
  info: (scope: string, message: string, data?: unknown) => write("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write("error", scope, message, data),
};

/** Absolute path to the log file, for surfacing in errors and docs. */
export function logFilePath(): string {
  return path.join(app.getPath("userData"), "logs", "main.log");
}
