// Test auto-restore: dispose must KEEP the flag; a new instance restores the tunnel.
import { MobileAccessService } from "../src/bun/mobile-access.ts";
import { userDataDir } from "../src/bun/logger.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const flag = join(userDataDir(), "cloudflared", "tunnel-auto.json");
const MOCK_PORT = 3080; // the live dev engine; proxy will land on 3081 or shift

const svc = new MobileAccessService();
await svc.start(MOCK_PORT);
console.log("started, proxyPort:", (await (async () => { const s = svc.status(); return s.proxyPort; })()));

console.log("starting tunnel (real cloudflared)...");
const url = await svc.startTunnel();
console.log("tunnel url:", url);
console.log("flag exists after start:", existsSync(flag));

// Simulate shutdown: dispose() must NOT clear the flag.
await svc.dispose();
console.log("after dispose: flag still exists:", existsSync(flag));
console.log("after dispose: status tunnel running:", svc.status().tunnel.running);

// Simulate relaunch: a fresh instance should auto-restore.
const svc2 = new MobileAccessService();
await svc2.start(MOCK_PORT);
console.log("new instance started; waiting for auto-restore...");
let restored = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const t = svc2.status().tunnel;
  if (t.running) { restored = true; console.log(`auto-restored after ${i}s: ${t.url}`); break; }
}
if (!restored) console.log("NOT restored; state:", JSON.stringify(svc2.status().tunnel));

await svc2.dispose();
// clean up flag (explicit off)
await svc2.start(MOCK_PORT);
svc2.stopTunnel();
console.log("cleanup: flag removed:", !existsSync(flag));
process.exit(restored ? 0 : 1);
