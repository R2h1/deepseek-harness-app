/**
 * Backend process manager for the desktop shell.
 *
 * The shell is only a supervisor: it resolves how to launch the real `dsh web`
 * backend, spawns it as a child process, and learns the served URL from the
 * `dsh web: http://127.0.0.1:<port>` line the CLI prints once its Loader tree
 * settles (we ask for an OS-assigned port with `--port 0`, so there is never a
 * fixed-port collision with an already-running harness).
 *
 * Active-backend resolution order:
 *  1. `DSH_DESKTOP_BACKEND_DIR` (explicit override)
 *  2. the user-data backend (`%LOCALAPPDATA%\dsh-desktop\backend`) — the
 *     runtime self-update target populated by `updater.ts` whenever a newer
 *     `@deepseek-ai/dsh` exists on npm
 *  3. `resources/backend` bundled with the app (provisioned by
 *     `pnpm backend:provision`), which is the offline fallback
 *  4. a local `deepseek-harness` checkout (`DSH_DESKTOP_DEV_BACKEND` or a
 *     sibling `../deepseek-harness`) for development
 *  5. `npx --yes @deepseek-ai/dsh web` as a last-resort external fallback
 */
import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { info, error, userDataDir } from "./logger";

export const URL_PREFIX = "dsh web: ";

const BUNDLED_BACKEND_ENTRY = "node_modules/@deepseek-ai/dsh/lib/bin.js";
const NODE_BINARY = process.platform === "win32" ? "node.exe" : "node";

export type BackendKind = "bundled" | "source" | "external";

export interface BackendSpec {
  /** Executable to launch (a Node binary, or `npx` for the external fallback). */
  node: string;
  /** Full argv after the executable. */
  args: string[];
  /** Working directory the backend runs from. */
  cwd: string;
  kind: BackendKind;
}

/** The app code folder in a bundled app: the Bun process runs from `<app>/bin`. */
export function appCodeDir(): string {
  return resolve(process.cwd(), "../Resources/app");
}

/** The bundled backend directory, when it was provisioned and installed. */
export function bundledBackendDir(): string | null {
  const dir = join(appCodeDir(), "backend");
  return existsSync(join(dir, BUNDLED_BACKEND_ENTRY)) ? dir : null;
}

/** The runtime self-update backend directory under the user-data folder. */
export function userDataBackendDir(): string {
  return join(userDataDir(), "backend");
}

/** The bundled Node runtime, when present. */
export function bundledNode(): string | null {
  const candidate = join(appCodeDir(), "node", NODE_BINARY);
  return existsSync(candidate) ? candidate : null;
}

/** The Node executable the shell uses to run the backend. */
export function nodeBin(): string {
  return process.env.DSH_DESKTOP_NODE?.trim() || bundledNode() || "node";
}

/** Read the VERSION marker of a backend directory, if present. */
export function readVersion(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, "VERSION"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** The bundled backend version, when it was provisioned. */
export function readBundledVersion(): string | null {
  const dir = bundledBackendDir();
  return dir ? readVersion(dir) : null;
}

function isSourceCheckout(dir: string): boolean {
  return existsSync(join(dir, "apps/cli/src/bin.ts"));
}

function isInstalledBackend(dir: string): boolean {
  return existsSync(join(dir, BUNDLED_BACKEND_ENTRY));
}

/** A local deepseek-harness checkout used for development. */
function devSourceDir(): string | null {
  const override = process.env.DSH_DESKTOP_DEV_BACKEND?.trim();
  const candidates = [
    ...(override && override.length > 0 ? [override] : []),
    resolve(process.cwd(), "../deepseek-harness"),
  ];
  for (const dir of candidates) {
    if (isSourceCheckout(dir)) return dir;
  }
  return null;
}

/** The currently active backend directory (user-data → bundled → source), if any. */
export function preferredBackendDir(): { dir: string; kind: BackendKind } | null {
  const env = process.env.DSH_DESKTOP_BACKEND_DIR?.trim();
  const candidates: { dir: string; kind: BackendKind }[] = [];
  if (env) candidates.push({ dir: env, kind: "bundled" });
  candidates.push({ dir: userDataBackendDir(), kind: "bundled" });
  const bundled = bundledBackendDir();
  if (bundled) candidates.push({ dir: bundled, kind: "bundled" });
  const source = devSourceDir();
  if (source) candidates.push({ dir: source, kind: "source" });
  for (const candidate of candidates) {
    const valid = candidate.kind === "source"
      ? isSourceCheckout(candidate.dir)
      : isInstalledBackend(candidate.dir);
    if (valid) return candidate;
  }
  return null;
}

/** The active backend version (user-data first, then bundled), for display. */
export function readActiveVersion(): string | null {
  const preferred = preferredBackendDir();
  return preferred ? readVersion(preferred.dir) : null;
}

/** Build the launch command for a resolved backend directory. */
export function makeSpec(dir: string): BackendSpec {
  if (isSourceCheckout(dir)) {
    return {
      node: nodeBin(),
      args: [
        "--expose-internals",
        "--import",
        "tsx/esm",
        "apps/cli/src/bin.ts",
        "web",
        "--port",
        "0",
      ],
      cwd: dir,
      kind: "source",
    };
  }
  return {
    node: nodeBin(),
    args: ["--expose-internals", BUNDLED_BACKEND_ENTRY, "web", "--port", "0"],
    cwd: dir,
    kind: "bundled",
  };
}

/** Resolve how this shell should launch the backend, best source first. */
export function resolveBackendSpec(): BackendSpec {
  const preferred = preferredBackendDir();
  if (preferred) {
    info(
      `backend: using ${preferred.kind} backend at ${preferred.dir} (v${readVersion(preferred.dir) ?? "?"})`,
    );
    return makeSpec(preferred.dir);
  }
  info("backend: no bundled, user-data, or checkout backend found; falling back to npx @deepseek-ai/dsh");
  return {
    node: "npx",
    args: ["--yes", "@deepseek-ai/dsh", "web", "--port", "0"],
    cwd: process.cwd(),
    kind: "external",
  };
}

/** Spawn the backend with piped stdout/stderr and the current environment. */
export function spawnBackend(spec: BackendSpec): Bun.Subprocess {
  info(`backend: spawning (${spec.kind}) ${spec.node} ${spec.args.join(" ")}  cwd=${spec.cwd}`);
  return spawn([spec.node, ...spec.args], {
    cwd: spec.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

/** Extract the full `dsh web:` URL from a backend stdout line, if present. */
export function parseUrlLine(line: string): string | null {
  const index = line.indexOf(URL_PREFIX);
  if (index < 0) return null;
  const rest = line.slice(index + URL_PREFIX.length).trim();
  return rest.startsWith("http://") ? rest : null;
}

/**
 * Read a subprocess stream line by line, invoking the callback per line.
 * Resolves when the stream closes.
 */
export async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    }
    if (buffer.length > 0) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** Unix: how long to wait for the engine to exit after SIGTERM before force-killing. */
const GRACEFUL_SHUTDOWN_WAIT_MS = 2000;
/** Windows: the engine's session write-behind batches at ~200ms; give it a beat to
 *  flush before the force kill so a torn/duplicated write can't corrupt a session. */
const WINDOWS_FLUSH_GRACE_MS = 600;

/**
 * Stop the backend process tree. On Unix this sends SIGTERM and waits for a graceful
 * exit (the engine flushes sessions on the way out). On Windows there is no reliable
 * graceful signal for a console-less Node child, so we wait a short flush grace and
 * then force-kill the tree — never killing mid-write, which can corrupt session logs.
 */
export async function killProcessTree(proc: Bun.Subprocess): Promise<void> {
  const pid = proc.pid;
  if (pid) info(`backend: stopping process tree pid=${pid}`);

  if (process.platform !== "win32") {
    // Graceful: SIGTERM, then wait for a clean exit.
    try {
      proc.kill();
    } catch {
      // already gone
    }
    const exited = await Promise.race([
      proc.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), GRACEFUL_SHUTDOWN_WAIT_MS)),
    ]);
    if (exited) return;
    info(`backend: still alive after ${GRACEFUL_SHUTDOWN_WAIT_MS}ms — force killing`);
  } else if (pid) {
    // Windows: let pending session writes flush before the force kill.
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_FLUSH_GRACE_MS));
  }

  // Force-kill the process tree.
  if (process.platform === "win32" && pid) {
    try {
      await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } catch (err) {
      error(`backend: taskkill failed: ${String(err)}`);
    }
  }
  try {
    proc.kill();
  } catch {
    // already terminated
  }
  try {
    await proc.exited;
  } catch {
    // ignore wait failures
  }
}
