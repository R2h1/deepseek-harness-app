/**
 * Single-instance guard for the desktop shell.
 *
 * Windows uses a named kernel32 mutex: the OS auto-releases it when the
 * process dies, so a stale lock can never block a later launch. Other
 * platforms use a PID lock file in the user-data directory with a liveness
 * check. A failure to acquire either lock fails open — the shell never
 * refuses to start because of a locking error.
 */
import { dlopen, ptr } from "bun:ffi";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userDataDir } from "./logger";

/**
 * Windows named mutex for the single-instance guard. Uses the `Local\` namespace:
 * it is per-login-session and — unlike `Global\` — a non-elevated process can
 * open it, so an elevated instance and a normal-user instance of the app see the
 * same lock. (With `Global\` + fail-open, a normal-user copy couldn't open the
 * elevated instance's mutex and would run anyway → two engines writing the same
 * session → corruption.)
 */
const WINDOWS_MUTEX_NAME = "Local\\DSHDesktop.SingleInstance";
const ERROR_ALREADY_EXISTS = 183;
const PID_LOCK_FILENAME = "single-instance.pid";

/** Keep the Windows mutex handle alive for the whole process lifetime. */
let windowsMutexHandle: unknown = null;

function acquireWindowsMutex(): boolean {
  try {
    const kernel32 = dlopen("kernel32.dll", {
      CreateMutexW: { args: ["ptr", "bool", "ptr"], returns: "ptr" },
      GetLastError: { args: [], returns: "u32" },
      CloseHandle: { args: ["ptr"], returns: "bool" },
    });
    // Wide-char (UTF-16LE) name with a null terminator, as CreateMutexW expects.
    const wide = Array.from(WINDOWS_MUTEX_NAME, (ch) => ch.charCodeAt(0));
    wide.push(0);
    const nameBuffer = new Uint8Array(new Uint16Array(wide).buffer);

    const mutex = kernel32.symbols.CreateMutexW(null, false, ptr(nameBuffer));
    const alreadyExists = kernel32.symbols.GetLastError() === ERROR_ALREADY_EXISTS;
    if (alreadyExists) {
      kernel32.symbols.CloseHandle(mutex);
      return false;
    }
    windowsMutexHandle = mutex;
    return true;
  } catch {
    return true; // fail open
  }
}

function pidLockPath(): string {
  return join(userDataDir(), PID_LOCK_FILENAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePidLock(): boolean {
  try {
    const lock = pidLockPath();
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return false; // another instance holds the lock
      }
      rmSync(lock, { force: true }); // stale lock from a dead process
    }
    writeFileSync(lock, String(process.pid));
    process.on("exit", () => {
      try {
        rmSync(lock, { force: true });
      } catch {
        // best-effort cleanup
      }
    });
    return true;
  } catch {
    return true; // fail open
  }
}

/** Acquire the single-instance lock. Returns false when another instance is running. */
export function acquireSingleInstance(): boolean {
  if (process.platform === "win32") return acquireWindowsMutex();
  return acquirePidLock();
}
