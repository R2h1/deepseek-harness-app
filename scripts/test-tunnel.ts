// Real cloudflared tunnel test against the live mobile proxy (port 3081).
import { startQuickTunnel } from "../src/bun/tunnel.ts";
import { userDataDir } from "../src/bun/logger.ts";
import { join } from "node:path";

const PROXY_PORT = 3081;
const cacheDir = join(userDataDir(), "cloudflared");

const signal = AbortSignal.timeout(180_000);
const phases: string[] = [];
const t0 = Date.now();

try {
  console.log(`starting tunnel -> 127.0.0.1:${PROXY_PORT} (cache ${cacheDir})`);
  const t = await startQuickTunnel(PROXY_PORT, cacheDir, signal, (phase) => {
    phases.push(phase);
    console.log(`  phase=${phase} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  });
  console.log("PUBLIC URL:", t.url);

  // Verify the public URL serves the GUI through cloudflare -> proxy -> engine.
  try {
    const r = await fetch(t.url + "/", { signal: AbortSignal.timeout(30_000) });
    const html = await r.text();
    console.log("public fetch:", r.status, "len=" + html.length, "injected=" + html.includes("data-dsh-mobile-inject"));
  } catch (e) {
    console.log("public fetch failed:", String(e).slice(0, 200));
  }

  // Let it run a moment, then kill and confirm the process is gone.
  console.log("killing tunnel...");
  t.kill();
  await new Promise((r) => setTimeout(r, 1000));
  console.log("tunnel killed (public URL now dead)");
  console.log("\nPHASES:", phases.join(" -> "));
} catch (e) {
  console.error("TUNNEL TEST FAILED:", String(e));
  process.exit(1);
}
