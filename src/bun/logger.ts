/**
 * Minimal file logger for the desktop shell.
 *
 * Writes timestamped lines to `<userData>/logs/desktop.log`. The user-data
 * directory follows the per-OS convention (LOCALAPPDATA on Windows, Library
 * on macOS, ~/.local/share on Linux) and can be overridden with
 * `DSH_DESKTOP_USER_DATA` for testing. Errors also echo to the console.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

/** The per-user data directory this shell owns. */
export function userDataDir(): string {
  const override = process.env.DSH_DESKTOP_USER_DATA?.trim();
  if (override && override.length > 0) return override;
  const platform = process.platform;
  const home = homedir();
  if (platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? home, "dsh-desktop");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "dsh-desktop");
  }
  return join(home, ".local", "share", "dsh-desktop");
}

function logPath(): string {
  const dir = join(userDataDir(), "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // logging is best-effort; never crash the shell on a write failure
  }
  return join(dir, "desktop.log");
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function writeLine(level: "INFO" | "ERROR" | "WARN", message: string): void {
  const line = `[${stamp()} ${level}] ${message}`;
  try {
    appendFileSync(logPath(), line + "\n");
  } catch {
    // ignore write failures — the console line below is the fallback
  }
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const info = (message: string) => writeLine("INFO", message);
export const warn = (message: string) => writeLine("WARN", message);
export const error = (message: string) => writeLine("ERROR", message);
