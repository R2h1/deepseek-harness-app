/**
 * Backend process manager for the desktop shell.
 *
 * The shell is only a supervisor: it resolves how to launch the real `dsh web`
 * backend, spawns it as a child process, and learns the served URL from the
 * `dsh web: http://127.0.0.1:<port>` line the CLI prints once its Loader tree
 * settles (we ask for an OS-assigned port with `--port 0`, so there is never a
 * fixed-port collision with an already-running harness).
 *
 * Resolution order:
 *  1. `resources/backend` bundled with the app (provisioned by
 *     `pnpm backend:provision` from the latest `@deepseek-ai/dsh` on npm) and a
 *     bundled Node runtime at `resources/node`.
 *  2. A local `deepseek-harness` checkout (`DSH_DESKTOP_DEV_BACKEND` or a
 *     sibling `../deepseek-harness`) for development.
 *  3. `npx --yes @deepseek-ai/dsh web` as a last-resort external fallback.
 */
import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { info, error } from "./logger";

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
function appCodeDir(): string {
  return resolve(process.cwd(), "../Resources/app");
}

/** The bundled backend directory, when it was provisioned and installed. */
export function bundledBackendDir(): string | null {
  const dir = join(appCodeDir(), "backend");
  return existsSync(join(dir, BUNDLED_BACKEND_ENTRY)) ? dir : null;
}

/** The bundled Node runtime, when present. */
export function bundledNode(): string | null {
  const candidate = join(appCodeDir(), "node", NODE_BINARY);
  return existsSync(candidate) ? candidate : null;
}

/** The version recorded by `pnpm backend:provision`, when the backend is bundled. */
export function readBundledVersion(): string | null {
  const dir = bundledBackendDir();
  if (!dir) return null;
  try {
    const raw = readFileSync(join(dir, "VERSION"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** A local deepseek-harness checkout used for development. */
function devSourceDir(): string | null {
  const override = process.env.DSH_DESKTOP_DEV_BACKEND?.trim();
  const candidates = [
    ...(override && override.length > 0 ? [override] : []),
    resolve(process.cwd(), "../deepseek-harness"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "apps/cli/src/bin.ts"))) return dir;
  }
  return null;
}

/** Resolve how this shell should launch the backend, best source first. */
export function resolveBackendSpec(): BackendSpec {
  const bundled = bundledBackendDir();
  if (bundled) {
    const node = process.env.DSH_DESKTOP_NODE?.trim() || bundledNode() || "node";
    info(`backend: using bundled backend at ${bundled}`);
    return {
      node,
      args: [
        "--expose-internals",
        BUNDLED_BACKEND_ENTRY,
        "web",
        "--port",
        "0",
      ],
      cwd: bundled,
      kind: "bundled",
    };
  }

  const source = devSourceDir();
  if (source) {
    const node = process.env.DSH_DESKTOP_NODE?.trim() || "node";
    info(`backend: using source checkout at ${source}`);
    return {
      node,
      args: [
        "--expose-internals",
        "--import",
        "tsx/esm",
        "apps/cli/src/bin.ts",
        "web",
        "--port",
        "0",
      ],
      cwd: source,
      kind: "source",
    };
  }

  info("backend: no bundled backend or checkout found; falling back to npx @deepseek-ai/dsh");
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

/** Terminate the backend process tree (taskkill /T on Windows, SIGTERM elsewhere). */
export async function killProcessTree(proc: Bun.Subprocess): Promise<void> {
  const pid = proc.pid;
  if (process.platform === "win32" && pid) {
    try {
      info(`backend: killing process tree pid=${pid}`);
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
