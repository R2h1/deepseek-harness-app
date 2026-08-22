// Test PIN gate + dual-stack (IPv4 LAN free, IPv6/tunnel gated).
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
console.log("pin:", pin, "proxy:", proxyPort, "status:", svc.status().statusPort);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
};

// 1. IPv4 LAN (127.0.0.1) -> no gate
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`);
  const html = await r.text();
  check("IPv4 LAN: no PIN gate", html.includes("mock") && !html.includes("访问验证"), `status=${r.status}`);
}
// 2. IPv6 ([::1]) -> login page (browser-style Accept)
{
  const r = await fetch(`http://[::1]:${proxyPort}/`, { headers: { accept: "text/html,application/xhtml+xml" } }).catch(() => null);
  if (!r) check("IPv6: reachable (dual-stack)", false, "connection failed");
  else {
    const html = await r.text();
    check("IPv6: login page shown", html.includes("访问验证") || html.includes("PIN"), `status=${r.status}`);
  }
}
// 3. IPv6 + valid cookie -> GUI
{
  const r = await fetch(`http://[::1]:${proxyPort}/`, { headers: { cookie: `dsh_mobile_pin=${pin}` } }).catch(() => null);
  if (!r) check("IPv6 + cookie: reachable", false, "connection failed");
  else {
    const html = await r.text();
    check("IPv6 + cookie: GUI", html.includes("mock") && !html.includes("访问验证"), `status=${r.status}`);
  }
}
// 4. login POST -> 302 + cookie
{
  const r = await fetch(`http://[::1]:${proxyPort}/dsh-mobile-login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `pin=${pin}`,
    redirect: "manual",
  }).catch(() => null);
  if (!r) check("login POST: reachable", false, "connection failed");
  else {
    const ck = r.headers.get("set-cookie") ?? "";
    check("login POST: 302 + HttpOnly cookie", r.status === 302 && ck.includes("dsh_mobile_pin") && ck.includes("HttpOnly"), `status=${r.status}`);
  }
}
// 5. wrong pin -> error
{
  const r = await fetch(`http://[::1]:${proxyPort}/dsh-mobile-login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "pin=00000000",
  }).catch(() => null);
  if (!r) check("wrong pin: reachable", false, "connection failed");
  else {
    const html = await r.text();
    check("wrong pin: error shown", html.includes("PIN 错误"), "");
  }
}
// 6. tunnel Host via IPv4 -> login page (browser-style Accept)
{
  const r = await fetch(`http://127.0.0.1:${proxyPort}/`, { headers: { host: "abc.trycloudflare.com", accept: "text/html" } });
  const html = await r.text();
  check("tunnel Host: login page", html.includes("访问验证"), `status=${r.status}`);
}
// 7. IPv6 API without cookie -> 401
{
  const r = await fetch(`http://[::1]:${proxyPort}/api/session.list`, { headers: { accept: "application/json" } }).catch(() => null);
  if (!r) check("IPv6 API: reachable", false, "connection failed");
  else check("IPv6 API no cookie: 401", r.status === 401, `status=${r.status}`);
}

await svc.dispose();
mock.stop(true);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
