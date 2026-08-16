#!/usr/bin/env node
/**
 * Provision the bundled DeepSeek Harness backend into resources/backend and a
 * Node runtime into resources/node.
 *
 *  - Resolves `@deepseek-ai/dsh` from npm (the `latest` tag by default;
 *    `--version <version>` pins an exact one).
 *  - Installs it with pnpm inside resources/backend, explicitly allowing the
 *    native build scripts (node-pty, koffi, ...) the dsh backend needs.
 *  - Records the resolved version in resources/backend/VERSION.
 *  - Copies the running Node runtime (node.exe + ICU data on Windows) into
 *    resources/node.
 *
 * Run `pnpm backend:provision` before `pnpm build:stable` so the backend is
 * bundled into the app. Re-run it any time you want to move to the newest dsh.
 */
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = join(root, "resources", "backend");
const nodeDir = join(root, "resources", "node");

const argv = process.argv.slice(2);
const versionIndex = argv.indexOf("--version");
const pinnedVersion = versionIndex >= 0 ? argv[versionIndex + 1] : undefined;
if (pinnedVersion === undefined && versionIndex >= 0) {
  console.error("error: --version requires a value, e.g. `pnpm backend:pin 0.1.0-rc.6`");
  process.exit(1);
}

function run(command, cwd) {
  console.log(`> ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

// 1. Backend package manifest + pnpm allowBuilds for the native deps.
mkdirSync(backendDir, { recursive: true });
writeFileSync(
  join(backendDir, "package.json"),
  JSON.stringify(
    {
      name: "dsh-desktop-backend",
      private: true,
      type: "module",
      dependencies: { "@deepseek-ai/dsh": pinnedVersion ?? "latest" },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(backendDir, "pnpm-workspace.yaml"),
  [
    "packages: []",
    // A flat, real-file node_modules (no symlinks): the electrobun build copies
    // resources with dereference, which would otherwise duplicate pnpm's
    // symlinked store and roughly double the bundled backend size.
    "nodeLinker: hoisted",
    "allowBuilds:",
    "  node-pty: true",
    "  koffi: true",
    "  '@deepseek-ai/dsh-subprocess-local': true",
    "  '@google/genai': false",
    "  protobufjs: false",
  ].join("\n") + "\n",
);

run("pnpm install", backendDir);

// 2. Record the resolved version for display and update checks.
const dshManifestPath = join(backendDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
if (!existsSync(dshManifestPath)) {
  console.error("error: @deepseek-ai/dsh was not installed; the backend bundle is incomplete");
  process.exit(1);
}
const dshVersion = JSON.parse(readFileSync(dshManifestPath, "utf8")).version;
writeFileSync(join(backendDir, "VERSION"), dshVersion + "\n");
console.log(`Bundled backend version: ${dshVersion}`);

// 3. Trim native packages that ship every platform's prebuilds (node-pty
//    bundles all four platforms in its main package). The backend only ever
//    runs the platform it was provisioned on.
const platformKey = `${process.platform}-${process.arch}`; // e.g. "win32-x64"
const ptyPrebuilds = join(backendDir, "node_modules", "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const entry of readdirSync(ptyPrebuilds)) {
    if (entry !== platformKey) {
      rmSync(join(ptyPrebuilds, entry), { recursive: true, force: true });
    }
  }
  console.log(`Trimmed node-pty prebuilds to ${platformKey}`);
}

// 3. Copy the running Node runtime beside the backend.
mkdirSync(nodeDir, { recursive: true });
const nodeTarget = process.platform === "win32" ? "node.exe" : "node";
const nodeSource = process.execPath;
copyFileSync(nodeSource, join(nodeDir, nodeTarget));
console.log(`Copied Node runtime from ${nodeSource}`);
const icuSource = join(dirname(nodeSource), "icudtl.dat");
if (existsSync(icuSource)) {
  copyFileSync(icuSource, join(nodeDir, "icudtl.dat"));
  console.log("Copied icudtl.dat (Node ICU data)");
}

console.log("\nDone. Rebuild the app so the bundled backend is packaged:");
console.log("  pnpm build:stable   (production installer)");
console.log("  pnpm backend:check  (compare bundled vs the latest @deepseek-ai/dsh)");
