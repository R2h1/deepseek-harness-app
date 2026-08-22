/**
 * cloudflared quick tunnel — expose the LAN proxy as a public https URL.
 *
 * The shell shells out to the `cloudflared` binary (downloaded on demand into the
 * user-data dir) to create a Cloudflare quick tunnel pointed at the local mobile
 * proxy. cloudflared prints a `https://<random>.trycloudflare.com` URL which we
 * parse from stdout. The URL rotates on every start — an old link dies immediately.
 *
 * Windows-first (the primary target); macOS/Linux are handled too (tgz extraction).
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { info, warn } from "./logger";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Proxy of the GitHub release asset, for each of several mirrors (CN-friendly). */
const MIRRORS = [
  (asset: string) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const PARALLEL_SEGMENTS = 8;
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;

interface PlatformBinary {
  os: "windows" | "darwin" | "linux";
  arch: "amd64" | "arm64";
  ext: string; // "" or ".exe"
}

function platformBinary(): PlatformBinary {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const ext = os === "windows" ? ".exe" : "";
  return { os, arch, ext };
}

/** Stream a Response body to a file (append=true for multi-part merging). */
async function writeBody(res: Response, dest: string, append = false): Promise<void> {
  if (!res.body) throw new Error("empty response body");
  const flags = append ? "a" : "w";
  const out = createWriteStream(dest, { flags });
  try {
    await pipeline(Readable.fromWeb(res.body as never), out);
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/** Merge part files (already on disk) into one destination file. */
async function mergeParts(parts: string[], dest: string): Promise<void> {
  const out = createWriteStream(dest);
  try {
    for (const part of parts) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(part);
        rs.on("error", reject);
        rs.pipe(out, { end: false });
        rs.on("end", resolve);
      });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

/**
 * Download a file, adaptive: single-stream when the server doesn't support Range or
 * the file is small; otherwise probe the speed and fall back to parallel Range
 * chunks (which turns a ~200KB/s official-source crawl into ~1.6MB/s on 8 segments).
 */
async function downloadFile(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const head = await fetch(url, { method: "HEAD", signal }).catch(() => null);
  const len = head ? Number(head.headers.get("content-length") || 0) : 0;
  const acceptsRanges = head
    ? String(head.headers.get("accept-ranges") || "").toLowerCase() === "bytes"
    : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeBody(res, dest);
    return;
  }

  const chunk = Math.ceil(len / PARALLEL_SEGMENTS);
  const parts: Array<{ start: number; end: number; file: string }> = [];
  for (let i = 0; i < PARALLEL_SEGMENTS; i++) {
    const start = i * chunk;
    const end = i === PARALLEL_SEGMENTS - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(
      parts.map(async (part) => {
        const res = await fetch(url, {
          signal,
          headers: { Range: `bytes=${part.start}-${part.end}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} (range)`);
        await writeBody(res, part.file);
      }),
    );
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
}

/** Find the real binary inside an extracted cloudflared package (GitHub tgz or Homebrew bottle layout). */
async function findExtractedBinary(extractDir: string, ext: string): Promise<string | null> {
  const direct = join(extractDir, `cloudflared${ext}`);
  try {
    if ((await stat(direct)).isFile()) return direct;
  } catch {
    /* not there */
  }
  try {
    const versions = await readdir(join(extractDir, "cloudflared"));
    for (const v of versions) {
      const bin = join(extractDir, "cloudflared", v, "bin", `cloudflared${ext}`);
      try {
        if ((await stat(bin)).isFile()) return bin;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* no such layout */
  }
  return null;
}

/** Download (or extract) cloudflared into cacheDir; returns the binary path. */
async function downloadCloudflared(cacheDir: string, signal: AbortSignal): Promise<string> {
  const { os, arch, ext } = platformBinary();
  const tmpFile = join(cacheDir, "cloudflared.download");
  const isWindows = os === "windows";
  const asset = isWindows
    ? `cloudflared-windows-${arch}.exe`
    : `cloudflared-${os}-${arch}.tgz`;

  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  let lastErr: unknown = null;
  for (let i = 0; i < MIRRORS.length; i++) {
    const url = MIRRORS[i](asset);
    const host = new URL(url).host;
    info(`cloudflared: downloading from mirror ${i + 1}/${MIRRORS.length} (${host})`);
    try {
      await downloadFile(url, tmpFile, fetchSignal);
      const st = await stat(tmpFile);
      if (st.size < 1024 * 1024) throw new Error(`file suspiciously small (${st.size} B)`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await rm(tmpFile, { force: true }).catch(() => {});
      warn(`cloudflared: mirror ${i + 1} failed: ${String(err)}`);
    }
  }
  if (lastErr) {
    throw new Error(
      `cloudflared download failed from all mirrors (last: ${String(lastErr)}). ` +
        (isWindows
          ? `Install it manually: winget install cloudflared, or drop cloudflared-windows-${arch}.exe into ${cacheDir}.`
          : `Install it manually: npm i -g cloudflared, then retry.`),
    );
  }

  const finalBin = join(cacheDir, `cloudflared${ext}`);
  if (isWindows) {
    await rename(tmpFile, finalBin).catch(async () => {
      await copyFile(tmpFile, finalBin).catch(() => {});
    });
  } else {
    const extractDir = join(cacheDir, `.extract-${process.pid}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tmpFile, "-C", extractDir], { stdio: "ignore" });
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
        child.once("error", reject);
      });
      const found = await findExtractedBinary(extractDir, ext);
      if (!found) throw new Error("binary not found after extraction");
      await rename(found, finalBin).catch(async () => {
        await copyFile(found, finalBin).catch(() => {});
      });
      await chmod(finalBin, 0o755);
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await rm(tmpFile, { force: true }).catch(() => {});
  return finalBin;
}

function cloudflaredOnPath(): boolean {
  try {
    execSync(process.platform === "win32" ? "where cloudflared" : "command -v cloudflared", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable cloudflared binary: PATH first, then the persistent cache,
 * downloading into the cache only when missing (so public access is instant once
 * downloaded). Reports phases for the UI.
 */
export async function resolveCloudflared(
  cacheDir: string,
  onPhase: (phase: string) => void,
  signal: AbortSignal,
): Promise<string> {
  if (cloudflaredOnPath()) return "cloudflared";
  const { os, arch, ext } = platformBinary();
  const candidates = [join(cacheDir, `cloudflared${ext}`), join(cacheDir, `cloudflared-${os}-${arch}${ext}`)];
  for (const bin of candidates) {
    try {
      await access(bin);
      return bin;
    } catch {
      /* keep looking */
    }
  }
  onPhase("downloading");
  await mkdir(cacheDir, { recursive: true });
  return downloadCloudflared(cacheDir, signal);
}

export interface QuickTunnel {
  url: string;
  /** Stop the tunnel process (proxy keeps running). */
  kill: () => void;
  /** Subscribe to unexpected process exit (code); returns an unsubscribe fn. */
  onExit: (cb: (code: number | null) => void) => () => void;
}

/**
 * Start a cloudflared quick tunnel pointing at the local proxy port.
 * Progress: downloading → starting → registering → ready | error.
 * @param port - the local mobile-proxy port cloudflared exposes.
 * @param cacheDir - where to cache the cloudflared binary.
 */
export async function startQuickTunnel(
  port: number,
  cacheDir: string,
  signal: AbortSignal,
  onPhase: (phase: string) => void,
): Promise<QuickTunnel> {
  const bin = await resolveCloudflared(cacheDir, onPhase, signal);
  onPhase("starting");
  // --protocol http2 (TCP 443) instead of QUIC (UDP 7844): CN networks and some
  // corporate nets block UDP 7844, causing error 1033; HTTP/2 over 443 is reliable.
  const child = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", "http2", "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let cleanup: (() => void) | null = null;
  const exitListeners = new Set<(code: number | null) => void>();

  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: unknown): void => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup?.();
        onPhase("ready");
        resolve(m[0]);
      }
    };
    const onExit = (code: number): void => {
      cleanup?.();
      reject(new Error(`cloudflared exited early (code ${code})`));
    };
    const timer = setTimeout(() => {
      cleanup?.();
      child.kill();
      reject(new Error("cloudflared took too long to register (30s)"));
    }, 30_000);
    const onAbort = (): void => {
      cleanup?.();
      child.kill();
      reject(new Error("tunnel cancelled"));
    };
    cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };

    child.on("error", (err) => {
      cleanup?.();
      reject(new Error(`cloudflared failed to start: ${String(err)}`));
    });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    onPhase("registering");
  });

  // Surface unexpected later exits (crash/kill) to the caller.
  child.on("exit", (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
