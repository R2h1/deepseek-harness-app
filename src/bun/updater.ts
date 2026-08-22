/**
 * Runtime self-update of the bundled backend.
 *
 * The shell bundles a base backend as an offline fallback, but on launch it
 * checks npm for the latest `@deepseek-ai/dsh`. When a newer version exists it
 * installs that version into the user-data backend directory using the bundled
 * Node runtime and bundled pnpm CLI, then boots from there — so the app tracks
 * upstream releases without ever being repackaged.
 */
import { spawn } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { info, warn, error } from "./logger";
import {
  appCodeDir,
  consumeLines,
  killProcessTree,
  nodeBin,
  userDataBackendDir,
} from "./backend";

const REGISTRY_URL =
  process.env.DSH_DESKTOP_REGISTRY || "https://registry.npmjs.org/@deepseek-ai/dsh/latest";

/** The pnpm version bundled for runtime installs (matches provisioning). */
const PNPM_VERSION = "11.22.0";

/** The install settings a runtime-installed backend must use (hoisted + native builds). */
const BACKEND_WORKSPACE_YAML = [
  "packages: []",
  "nodeLinker: hoisted",
  "allowBuilds:",
  "  node-pty: true",
  "  koffi: true",
  "  '@deepseek-ai/dsh-subprocess-local': true",
  "  '@google/genai': false",
  "  protobufjs: false",
].join("\n") + "\n";

/** The bundled pnpm CLI, when present (bundled layout first, then project dev layout). */
function pnpmCliPath(): string | null {
  const candidates = [
    join(appCodeDir(), "pnpm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
    join(process.cwd(), "resources", "pnpm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Query npm for the latest published @deepseek-ai/dsh version (null when offline). */
export async function queryNpmLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      warn(`update check: registry responded ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string" || data.version.length === 0) return null;
    return data.version;
  } catch (err) {
    warn(`update check: ${String(err)}`);
    return null;
  }
}

/**
 * Await a child's exit with a hard timeout. pnpm can print "Done" yet keep a
 * postinstall child alive (native builds such as node-pty/koffi download binaries
 * and can hang on flaky networks), which would otherwise block boot forever.
 * Returns the exit code, or null when the timeout fired (the tree is killed).
 */
async function waitWithTimeout(proc: Bun.Subprocess, ms: number, what: string): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    };
    const timer = setTimeout(() => {
      warn(`runtime update: ${what} hung for ${ms}ms — killing its process tree`);
      void killProcessTree(proc)
        .then(() => finish(proc.exitCode ?? 1))
        .catch(() => finish(1));
    }, ms);
    proc.exited.then((code) => finish(code), () => finish(1));
  });
}

/**
 * Install a specific `@deepseek-ai/dsh` version into the user-data backend
 * directory with the bundled Node + pnpm, recording the resolved version.
 * @param version - the exact version to install (from {@link queryNpmLatest}).
 * @param onStatus - progress callback rendered on the loader page.
 * @returns whether the install produced a working backend.
 */
export async function installBackend(
  version: string,
  onStatus: (status: string) => void,
): Promise<boolean> {
  const dir = userDataBackendDir();
  const pnpm = pnpmCliPath();
  if (!pnpm) {
    error("runtime update: bundled pnpm is missing; cannot install the latest backend");
    return false;
  }
  try {
    onStatus(`正在获取最新引擎 v${version} …`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "dsh-desktop-backend",
          private: true,
          type: "module",
          dependencies: { "@deepseek-ai/dsh": version },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), BACKEND_WORKSPACE_YAML);

    const proc = spawn([nodeBin(), pnpm, "install", "--no-frozen-lockfile"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (proc.stdout instanceof ReadableStream) {
      void consumeLines(proc.stdout, (line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) info(`update/pnpm: ${trimmed}`);
      });
    }
    if (proc.stderr instanceof ReadableStream) {
      void consumeLines(proc.stderr, (line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) info(`update/pnpm: ${trimmed}`);
      });
    }

    // Hard timeout: a hung postinstall must not block boot forever.
    const installMs = Number(process.env.DSH_DESKTOP_UPDATE_TIMEOUT_MS ?? 600_000);
    const code = await waitWithTimeout(proc, installMs, "pnpm install");
    if (code !== 0) {
      error(`runtime update: pnpm install failed (exit ${code})`);
      return false;
    }

    // Prune never-at-runtime files (types, sourcemaps, docs, tests) so the
    // installed backend stays compact, mirroring `pnpm backend:provision`.
    const trimScript = join(appCodeDir(), "trim-node-modules.mjs");
    if (existsSync(join(dir, "node_modules")) && existsSync(trimScript)) {
      const trim = spawn([nodeBin(), trimScript, join(dir, "node_modules")], {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      });
      const trimCode = await waitWithTimeout(trim, 120_000, "backend trim");
      if (trimCode !== 0) {
        warn(`runtime update: backend trim exited with code ${trimCode}`);
      }
    }

    const manifestPath = join(dir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    if (!existsSync(manifestPath)) {
      error("runtime update: install finished but @deepseek-ai/dsh was not resolved");
      return false;
    }
    const installed = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown }).version;
    if (typeof installed !== "string") {
      error("runtime update: installed package carries no version");
      return false;
    }
    writeFileSync(join(dir, "VERSION"), installed + "\n");
    info(`runtime update: backend is now ${installed} at ${dir}`);
    return true;
  } catch (err) {
    error(`runtime update failed: ${String(err)}`);
    return false;
  }
}

export { PNPM_VERSION };
