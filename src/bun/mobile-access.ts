/**
 * Mobile Access — first-party "phone access" for the desktop shell.
 *
 * The engine (`dsh web`) binds to 127.0.0.1 and its `/api` browser-trust fence only
 * trusts loopback authorities (`--host 0.0.0.0` is intentionally rejected upstream).
 * To let a phone reach it, this module runs a reverse proxy in the shell (Bun main
 * process) that:
 *   - listens on 0.0.0.0:<proxyPort>,
 *   - rewrites the inbound Origin to the loopback authority before forwarding to
 *     127.0.0.1:<dshPort> (the fence always sees loopback),
 *   - injects a crypto.randomUUID polyfill (missing in non-secure http://<LAN-IP>
 *     contexts) and a desktop-compat patch into HTML documents,
 *   - transparently proxies HTTP and WebSocket streams.
 *
 * A small status server (127.0.0.1:<statusPort>) feeds the "Mobile Access" UI
 * window: LAN URL, QR asset, tunnel state (Phase 2).
 *
 * Everything lives in the shell — the engine is never modified.
 */

import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "bun";

import { info, warn, userDataDir } from "./logger";
import { startQuickTunnel, type QuickTunnel } from "./tunnel";
import { mobileUiHtml } from "./mobile-ui";

export const MOBILE_PROXY_BASE_PORT = 3081;
export const MOBILE_STATUS_BASE_PORT = 3210;

/** Per-WebSocket data carried by the LAN proxy (upgrade url + upstream client). */
type WsData = { wsUrl: string; upstream?: WebSocket };

/* ------------------------------------------------------------------ */
/* LAN IPv4 selection                                                  */
/* ------------------------------------------------------------------ */

const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|本地连接)/i;
const VPN_IFACE_RE =
  /(?:radmin|tailscale|zerotier|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

export interface LanAddr {
  address: string;
  family: string;
  internal: boolean;
}
export type LanInterfaces = Record<string, LanAddr[]>;

/**
 * Pick the LAN IPv4 a phone is most likely able to reach. The enumeration order of
 * `os.networkInterfaces()` is unreliable (VPN/virtual adapters often rank ahead of
 * WLAN on Windows), so we score candidates: RFC1918 private ranges first, physical
 * adapter names get a bonus, VPN/virtual names get a penalty. Falls back to the
 * highest-scored address when nothing private exists.
 */
export function selectLanIPv4(interfaces: LanInterfaces): string | null {
  const candidates: Array<{ ip: string; score: number; order: number }> = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

function lanIPv4(): string | null {
  return selectLanIPv4(networkInterfaces() as unknown as LanInterfaces);
}

/* ------------------------------------------------------------------ */
/* HTML injection                                                      */
/* ------------------------------------------------------------------ */

const INJECT_MARK = "data-dsh-mobile-inject";

/** crypto.randomUUID polyfill — required in non-secure contexts (http://<LAN-IP>). */
const RANDOM_UUID_POLYFILL = `<script data-dsh-mobile-inject="uuid">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();</script>`;

/** Desktop-compat patch: the desktop client expects `dsh-desktop-mode`/`dsh-desktop-platform`
 *  query params; a phone browser lacks them and the client could crash. Inject the
 *  lightest `compatibility` mode via history.replaceState (no reload). */
function desktopCompatPatch(platform: string): string {
  const p = ["darwin", "win32", "linux"].includes(platform) ? platform : "linux";
  return `<script data-dsh-mobile-inject="desktop">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

function injectionScripts(platform: string): string {
  return RANDOM_UUID_POLYFILL + desktopCompatPatch(platform);
}

/* ------------------------------------------------------------------ */
/* Bundled asset resolution (qrcode lib)                               */
/* ------------------------------------------------------------------ */

function resolveMobileAsset(name: string): string | null {
  const candidates = [
    join(resolve(process.cwd(), "../Resources/app"), "mobile", name),
    join(process.cwd(), "resources", "mobile", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reverse proxy (Bun.serve)                                           */
/* ------------------------------------------------------------------ */

async function forwardHttp(req: Request, url: URL, upstream: string, inject: string): Promise<Response> {
  // Host and Origin must be rewritten to the loopback authority for the /api trust
  // fence (an explicit Host header in the inbound request would otherwise pass
  // through and be rejected as non-loopback).
  const headers = new Headers(req.headers);
  headers.set("host", upstream);
  const origin = `http://${upstream}`;
  if (headers.has("origin")) headers.set("origin", origin);
  if (headers.has("Origin")) headers.set("Origin", origin);

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`http://${upstream}${url.pathname}${url.search}`, init);
  } catch (err) {
    warn(`mobile proxy: upstream unreachable (${upstream}): ${String(err)}`);
    return new Response(
      `dsh-desktop mobile proxy: cannot reach the dsh engine at ${upstream} — is it running? | ${String(err)}`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const contentType = upstreamRes.headers.get("content-type") ?? "";
  if (inject && contentType.includes("text/html")) {
    const text = await upstreamRes.text();
    const out = text.includes(INJECT_MARK)
      ? text
      : text.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
    const outBuf = Buffer.from(out, "utf8");
    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("transfer-encoding");
    outHeaders.set("content-length", String(outBuf.length));
    return new Response(outBuf, { status: upstreamRes.status, headers: outHeaders });
  }

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: upstreamRes.headers });
}

function createProxy(dshPort: number, platform: string, port: number): Server<WsData> {
  const upstream = `127.0.0.1:${dshPort}`;
  const inject = injectionScripts(platform);

  return Bun.serve<WsData>({
    hostname: "0.0.0.0",
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      const wsUrl = `ws://${upstream}${url.pathname}${url.search}`;
      if (srv.upgrade(req, { data: { wsUrl } })) return undefined;
      return forwardHttp(req, url, upstream, inject);
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        let upstreamWs: WebSocket | null = null;
        try {
          upstreamWs = new WebSocket(data.wsUrl);
        } catch (err) {
          warn(`mobile proxy: upstream ws connect failed: ${String(err)}`);
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        ws.data = { ...data, upstream: upstreamWs };
        upstreamWs.onopen = () => { /* ready; messages flow both ways */ };
        upstreamWs.onmessage = (ev) => {
          const d = ev.data;
          if (typeof d === "string") {
            try { ws.send(d); } catch { /* ignore */ }
          } else if (d instanceof Blob) {
            void d.arrayBuffer().then((ab) => { try { ws.send(ab); } catch { /* ignore */ } });
          } else {
            try { ws.send(d as ArrayBuffer); } catch { /* ignore */ }
          }
        };
        upstreamWs.onclose = () => { try { ws.close(); } catch { /* ignore */ } };
        upstreamWs.onerror = () => { try { upstreamWs?.close(); } catch { /* ignore */ } };
      },
      message(ws, message) {
        const upstreamWs = ws.data.upstream;
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          try { upstreamWs.send(message); } catch { /* ignore */ }
        }
      },
      close(ws) {
        const upstreamWs = ws.data.upstream;
        try { upstreamWs?.close(); } catch { /* ignore */ }
      },
    },
  });
}

function createStatusServer(service: MobileAccessService, port: number): Server<undefined> {
  return Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/status") {
        return Response.json(service.status());
      }
      if (req.method === "GET" && url.pathname === "/mobile") {
        return new Response(mobileUiHtml(), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (req.method === "GET" && url.pathname === "/qrcode.min.js") {
        const lib = resolveMobileAsset("qrcode.min.js");
        if (!lib) return new Response("qrcode lib not bundled", { status: 500 });
        return new Response(readFileSync(lib), {
          headers: { "content-type": "application/javascript", "cache-control": "public, max-age=3600" },
        });
      }
      // Public tunnel control (Phase 2).
      if (req.method === "POST" && url.pathname === "/tunnel/start") {
        return service
          .startTunnel()
          .then((url) => Response.json({ url }))
          .catch((err) => Response.json({ error: String(err) }, { status: 500 }));
      }
      if (req.method === "POST" && url.pathname === "/tunnel/stop") {
        service.stopTunnel();
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

/** Try to bind at base..base+attempts-1; returns the first that succeeds. */
async function listenOnPort<T>(base: number, attempts: number, listen: (port: number) => T | Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let p = base; p < base + attempts; p++) {
    try {
      return await listen(p);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "EADDRINUSE") throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`no free port in ${base}..${base + attempts - 1}`);
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export interface MobileStatus {
  proxyRunning: boolean;
  proxyPort: number | null;
  statusPort: number | null;
  lanUrl: string | null;
  dshPort: number | null;
  tunnel: { running: boolean; url: string | null; phase: string; detail: string };
  pinEnabled: boolean;
}

export class MobileAccessService {
  private proxy: Server<WsData> | null = null;
  private statusServer: Server<undefined> | null = null;
  private proxyPort: number | null = null;
  private statusPort: number | null = null;
  private dshPort: number | null = null;

  private tunnel: QuickTunnel | null = null;
  private tunnelPhase = "idle";
  private tunnelDetail = "";
  private tunnelPromise: Promise<string> | null = null;
  private tunnelAbort: AbortController | null = null;

  private get tunnelCacheDir(): string {
    return join(userDataDir(), "cloudflared");
  }
  private get tunnelAutoPath(): string {
    return join(this.tunnelCacheDir, "tunnel-auto.json");
  }

  /** Port of the 127.0.0.1 status server (serves the Mobile Access UI + /status). */
  get mobileUiPort(): number | null {
    return this.statusPort;
  }

  /** Start the status server + LAN proxy for a dsh web port. Idempotent; restarts when the port changes. */
  async start(dshPort: number): Promise<{ proxyPort: number; statusPort: number }> {
    if (this.statusServer && this.dshPort === dshPort) {
      return { proxyPort: this.proxyPort!, statusPort: this.statusPort! };
    }
    await this.dispose();

    this.dshPort = dshPort;
    this.statusServer = await listenOnPort(MOBILE_STATUS_BASE_PORT, 20, (port) => createStatusServer(this, port));
    this.statusPort = this.statusServer.port ?? null;
    info(`mobile access: status server on 127.0.0.1:${this.statusPort}`);

    this.proxy = await listenOnPort(MOBILE_PROXY_BASE_PORT, 10, (port) => createProxy(dshPort, process.platform, port));
    this.proxyPort = this.proxy.port ?? null;
    info(`mobile access: LAN proxy on 0.0.0.0:${this.proxyPort} -> 127.0.0.1:${dshPort}`);

    // Re-open the public tunnel after a shell restart if it was on before.
    void this.restoreTunnelIfNeeded();

    return { proxyPort: this.proxyPort!, statusPort: this.statusPort! };
  }

  /** Start the public cloudflared tunnel (idempotent, single-flight). Returns the public URL. */
  async startTunnel(): Promise<string> {
    if (this.tunnel) return this.tunnel.url;
    if (this.tunnelPromise) return this.tunnelPromise;
    if (!this.proxyPort) throw new Error("LAN proxy is not running");

    const controller = new AbortController();
    this.tunnelAbort = controller;
    this.tunnelPhase = "starting";
    const holder: { p: Promise<string> | null } = { p: null };
    holder.p = (async () => {
      try {
        const t = await startQuickTunnel(this.proxyPort!, this.tunnelCacheDir, controller.signal, (phase) => {
          this.tunnelPhase = phase;
          this.tunnelDetail =
            phase === "downloading"
              ? "正在下载 cloudflared（约 50MB）…"
              : phase === "starting"
                ? "正在启动隧道…"
                : phase === "registering"
                  ? "正在连接 Cloudflare 边缘…"
                  : "";
        });
        this.tunnel = t;
        this.tunnelPhase = "ready";
        t.onExit((code) => {
          if (controller.signal.aborted) return;
          this.tunnelPhase = "error";
          this.tunnelDetail = `隧道进程退出（code ${code}）`;
        });
        this.persistAutoTunnel(true);
        return t.url;
      } catch (err) {
        if (!controller.signal.aborted) {
          this.tunnelPhase = "error";
          this.tunnelDetail = String(err);
        }
        throw err;
      } finally {
        if (this.tunnelPromise === holder.p) this.tunnelPromise = null;
      }
    })();
    this.tunnelPromise = holder.p;
    return holder.p;
  }

  stopTunnel(): void {
    this.tunnelAbort?.abort();
    this.tunnelAbort = null;
    this.tunnelPromise = null;
    if (this.tunnel) this.tunnel.kill();
    this.tunnel = null;
    this.tunnelPhase = "idle";
    this.tunnelDetail = "";
    this.persistAutoTunnel(false);
  }

  /** After a shell restart, re-open the public tunnel if it was on before. */
  async restoreTunnelIfNeeded(): Promise<void> {
    if (this.tunnel || this.tunnelPromise) return;
    try {
      const raw = readFileSync(this.tunnelAutoPath, "utf8");
      if (!/"at"\s*:/.test(raw)) return;
    } catch {
      return;
    }
    try {
      await this.startTunnel();
      info("mobile access: public tunnel auto-restored");
    } catch (err) {
      warn(`mobile access: tunnel auto-restore failed: ${String(err)}`);
    }
  }

  private persistAutoTunnel(on: boolean): void {
    try {
      if (on) {
        mkdirSync(this.tunnelCacheDir, { recursive: true });
        writeFileSync(this.tunnelAutoPath, JSON.stringify({ at: Date.now() }), "utf8");
      } else {
        rmSync(this.tunnelAutoPath, { force: true });
      }
    } catch {
      // best-effort
    }
  }

  status(): MobileStatus {
    const lan = lanIPv4();
    return {
      proxyRunning: this.proxy !== null,
      proxyPort: this.proxyPort,
      statusPort: this.statusPort,
      lanUrl: lan && this.proxyPort ? `http://${lan}:${this.proxyPort}` : null,
      dshPort: this.dshPort,
      tunnel: {
        running: this.tunnel !== null,
        url: this.tunnel?.url ?? null,
        phase: this.tunnelPhase,
        detail: this.tunnelDetail,
      },
      pinEnabled: false,
    };
  }

  async dispose(): Promise<void> {
    this.stopTunnel();
    if (this.proxy) {
      try { this.proxy.stop(true); } catch (err) { warn(`mobile proxy stop: ${String(err)}`); }
      this.proxy = null;
    }
    if (this.statusServer) {
      try { this.statusServer.stop(true); } catch (err) { warn(`mobile status server stop: ${String(err)}`); }
      this.statusServer = null;
    }
    this.proxyPort = null;
    this.statusPort = null;
    this.dshPort = null;
  }
}
