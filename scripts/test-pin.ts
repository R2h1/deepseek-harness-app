// Test PIN gate: LAN (IPv4) free; cloudflared tunnel Host gated by PIN.
import { MobileAccessService } from "../src/bun/mobile-access.ts";

const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response("<!doctype html><html><head><title>mock</title></head><body>mock</body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
const dshPort = mock.port as number;

const svc = new MobileAccessService();
const { proxyPort } = await svc.start(dshPort);
const pin = svc.getPin() ?? "";
console.log("pin:", pin, "proxy:", proxyPort);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
};
const TUNNEL = "abc.trycloudflare.com";

// 1. IPv4 LAN (127.0.0.1) -> no gate
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`);
  const html = await r.text();
  check("IPv4 LAN: no PIN gate", html.includes("mock") && !html.includes("访问验证"), `status=${r.status}`);
}
// 2. tunnel Host -> login page
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { host: TUNNEL, accept: "text/html" } });
  const html = await r.text();
  check("tunnel Host: login page", html.includes("访问验证"), `status=${r.status}`);
}
// 3. tunnel Host + valid cookie -> GUI
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { host: TUNNEL, cookie: `dsh_mobile_pin=${pin}` } });
  const html = await r.text();
  check("tunnel Host + cookie: GUI", html.includes("mock") && !html.includes("访问验证"), `status=${r.status}`);
}
// 4. login POST -> 302 + HttpOnly cookie
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/dsh-mobile-login`, {
    method: "POST",
    headers: { host: TUNNEL, "content-type": "application/x-www-form-urlencoded" },
    body: `pin=${pin}`,
    redirect: "manual",
  });
  const ck = r.headers.get("set-cookie") ?? "";
  check("login POST: 302 + HttpOnly cookie", r.status === 302 && ck.includes("dsh_mobile_pin") && ck.includes("HttpOnly"), `status=${r.status}`);
}
// 5. wrong pin -> error
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/dsh-mobile-login`, {
    method: "POST",
    headers: { host: TUNNEL, "content-type": "application/x-www-form-urlencoded" },
    body: "pin=00000000",
  });
  const html = await r.text();
  check("wrong pin: error shown", html.includes("PIN 错误"), "");
}
// 6. tunnel Host API without cookie -> 401
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/api/session.list`, { headers: { host: TUNNEL, accept: "application/json" } });
  check("tunnel API no cookie: 401", r.status === 401, `status=${r.status}`);
}

await svc.dispose();
mock.stop(true);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
