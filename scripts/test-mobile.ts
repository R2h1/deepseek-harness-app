// Dev regression test for mobile-access (LAN proxy + status server + WS bridge).
// Run: pnpm test:mobile   (starts a mock engine and asserts the proxy behavior)
import { MobileAccessService, selectLanIPv4 } from "../src/bun/mobile-access.ts";

// --- 1. LAN IP selection sanity ---
const fake = {
  "Radmin VPN": [{ address: "26.10.0.5", family: "IPv4", internal: false }],
  "Ethernet": [{ address: "192.168.1.5", family: "IPv4", internal: false }],
  "Wi-Fi": [{ address: "10.0.0.7", family: "IPv4", internal: false }],
  "Loopback Pseudo-Interface": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};
const lan = selectLanIPv4(fake as never);
console.log("LAN IP:", lan, "(expect 192.168.1.5: private + physical beats VPN)");

// --- 2. Mock dsh engine ---
const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/echo-origin") {
      return Response.json({ origin: req.headers.get("origin"), host: req.headers.get("host") });
    }
    if (url.pathname === "/api/evil" && srv.upgrade(req)) return undefined;
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined;
    }
    if (url.pathname === "/") {
      return new Response("<!doctype html><html><head><title>mock dsh</title></head><body>mock</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { ws.send("hello from mock"); },
    message(ws, m) { ws.send("echo:" + m); },
  },
});
const dshPort = mock.port as number;
console.log("mock dsh on port:", dshPort);

// --- 3. Start mobile access ---
const svc = new MobileAccessService();
const { proxyPort, statusPort } = await svc.start(dshPort);
console.log("proxy:", proxyPort, "status:", statusPort);

// --- 4. Assertions ---
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

// HTML injection through proxy
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`);
  const html = await r.text();
  check("proxy injects HTML", html.includes("data-dsh-mobile-inject"), `len=${html.length}`);
  check("proxy keeps content-length", r.headers.get("content-length") === String(html.length));
}

// Origin/Host rewrite (trust fence): send LAN origin, engine must see loopback
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/api/echo-origin`, {
    headers: { origin: "http://192.168.1.5:" + proxyPort, "host": "192.168.1.5:" + proxyPort },
  });
  const j = await r.json() as { origin: string | null; host: string | null };
  check("Origin rewritten to loopback", j.origin === `http://127.0.0.1:${dshPort}`, JSON.stringify(j));
  check("Host is loopback", j.host === `127.0.0.1:${dshPort}`, JSON.stringify(j));
}

// Status server
{
  const r = await fetch(`http://127.0.0.1:${statusPort}/status`);
  const j = await r.json() as { proxyRunning: boolean; lanUrl: string | null; proxyPort: number | null };
  check("status endpoint", r.ok && j.proxyRunning === true, JSON.stringify(j));
  check("lanUrl present", typeof j.lanUrl === "string" && j.lanUrl !== null, j.lanUrl ?? "null");
  check("lanUrl port = proxy port", j.lanUrl?.endsWith(`:${proxyPort}`) === true, j.lanUrl ?? "");
}
{
  const r = await fetch(`http://127.0.0.1:${statusPort}/mobile`);
  const html = await r.text();
  check("mobile UI served", r.ok && html.includes("手机访问") && html.includes("qrcode.min.js"), `len=${html.length}`);
}
{
  const r = await fetch(`http://127.0.0.1:${statusPort}/qrcode.min.js`);
  const js = await r.text();
  check("qrcode lib served", r.ok && js.includes("qrcode"), `len=${js.length}`);
}

// WebSocket echo through the proxy
{
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`);
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.onmessage = (ev) => { clearTimeout(t); resolve(String(ev.data)); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("ws error")); };
    });
    check("WS bridge: first frame", got === "hello from mock", got);
    ws.close();
  } catch (e) {
    check("WS bridge: first frame", false, String(e));
  }
}

await svc.dispose();
mock.stop(true);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
