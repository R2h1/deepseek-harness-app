// Real-engine compatibility test for mobile-access: point the proxy at the
// LIVE dsh engine (dev checkout on 127.0.0.1:3080) and verify the trust fence
// accepts our rewritten requests + HTML injection works on the real GUI page.
import { MobileAccessService } from "../src/bun/mobile-access.ts";

const DSH_PORT = 3080;

// 0. Sanity: is the real engine up?
const up = await fetch(`http://127.0.0.1:${DSH_PORT}/`).then((r) => r.status).catch(() => 0);
console.log("real dsh engine on", DSH_PORT, "-> status", up);

// 1. Prove the fence rejects an evil-origin request DIRECTLY (no proxy):
try {
  const evil = await fetch(`http://127.0.0.1:${DSH_PORT}/api/session.list`, {
    headers: { origin: "http://evil.example", host: `127.0.0.1:${DSH_PORT}` },
  });
  console.log("direct + evil origin ->", evil.status, "(expect 4xx = fence rejects)");
} catch (e) {
  console.log("direct + evil origin -> threw", String(e).slice(0, 80));
}

// 2. Start our proxy against the real engine.
const svc = new MobileAccessService();
const { proxyPort, statusPort } = await svc.start(DSH_PORT);
console.log("proxy:", proxyPort, "status:", statusPort);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
};

// 3. GUI HTML through proxy: injected?
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`);
  const html = await r.text();
  check("proxy: real GUI HTML served", r.ok, `status=${r.status} len=${html.length}`);
  check("proxy: injection present", html.includes("data-dsh-mobile-inject"), "");
}

// 4. Trust fence via proxy with LAN-ish headers: fence must see loopback.
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/api/session.list`, {
    headers: { origin: "http://192.168.1.32:" + proxyPort, host: "192.168.1.32:" + proxyPort },
  });
  check("proxy: /api with LAN origin accepted (not 403)", r.status !== 403 && r.status !== 401, `status=${r.status}`);
}

// 5. Status / mobile UI / qrcode
{
  const r = await fetch(`http://127.0.0.1:${statusPort}/status`);
  const j = await r.json() as { lanUrl: string | null; proxyRunning: boolean };
  check("status: proxyRunning + lanUrl", r.ok && j.proxyRunning && !!j.lanUrl, j.lanUrl ?? "");
}
{
  const r = await fetch(`http://127.0.0.1:${statusPort}/mobile`);
  const html = await r.text();
  check("status: mobile UI", r.ok && html.includes("手机访问"), `len=${html.length}`);
}

// 6. WebSocket through proxy to the real engine (events channel).
{
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/events.mux`);
    const opened = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 6000);
      ws.onopen = () => { clearTimeout(t); resolve(true); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
    check("proxy: WS to real engine opens", opened, "");
    try { ws.close(); } catch { /* ignore */ }
  } catch (e) {
    check("proxy: WS to real engine opens", false, String(e).slice(0, 80));
  }
}

await svc.dispose();
console.log(failures === 0 ? "\nALL PASS (real engine)" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
