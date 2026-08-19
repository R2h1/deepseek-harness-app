#!/usr/bin/env node
/**
 * Build the graphical (NSIS) installer for the desktop app.
 *
 * Pipeline:
 *   1. Ensure the electrobun stable build exists (build:stable).
 *   2. Decompress the app payload (DeepSeek Harness-Setup.tar.zst) and stage
 *      the raw app folder into build/stable-win-x64/_app.
 *   3. Compile scripts/installer.nsi with makensis into
 *      artifacts/DeepSeek Harness-Installer.exe — a classic Windows wizard
 *      installer (welcome / directory / progress / finish) with shortcuts and
 *      an uninstall entry.
 *
 * Requires NSIS. Point DSHP_NSIS_MAKENSIS at makensis.exe, or have it on PATH.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(root, "scripts");
const buildFolder = join(root, "build", "stable-win-x64");
const stagingDir = join(buildFolder, "_app");
const artifactsDir = join(root, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const isWin = process.platform === "win32";

function run(command, cwd) {
  console.log(`> ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function findMakensis() {
  const candidates = [
    process.env.DSHP_NSIS_MAKENSIS,
    // NSIS 3.x (Unicode) — required for the Simplified-Chinese installer UI.
    // Downloaded to dshtools; prefer it over the bundled NSIS 2.x (ANSI).
    "D:\\conan\\dshtools\\nsis-3.10\\nsis-3.10\\makensis.exe",
    "D:\\conan\\dshtools\\tools\\makensis.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  try {
    const found = execSync(isWin ? "where makensis" : "which makensis", { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    if (found) return found;
  } catch {
    // not on PATH — report below
  }
  throw new Error(
    "makensis not found. Install NSIS 3.x (Unicode) and set DSHP_NSIS_MAKENSIS to makensis.exe (or add it to PATH).",
  );
}

// 1. Stable build (and its compressed payload).
const tarZst = join(buildFolder, "DeepSeek Harness-Setup.tar.zst");
if (!existsSync(tarZst)) {
  run("bunx electrobun build --env=stable", root);
}

// 2. Decompress + stage the raw app folder.
const zigZstd = join(root, "node_modules", "electrobun", "dist-win-x64", "zig-zstd.exe");
if (!existsSync(zigZstd)) {
  throw new Error("zig-zstd.exe not found; is electrobun installed?");
}
const tar = join(buildFolder, "_app.tar");
rmSync(tar, { force: true });
run(`"${zigZstd}" decompress -i "${tarZst}" -o "${tar}"`, root);
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
run(`tar -xf "${tar}" -C "${stagingDir}" --strip-components=1`, root);
rmSync(tar, { force: true });
if (!existsSync(join(stagingDir, "bin", "launcher.exe"))) {
  throw new Error("staged app is missing bin/launcher.exe; the payload looks wrong");
}

// 2b. Embed the app icon into the packaged binaries. The electrobun CLI's own
//     rcedit integration can't resolve from its bundled runtime, so we run the
//     icon edit ourselves on the staged exes.
const rceditCandidates = [
  process.env.DSHP_RCEDIT,
  join(root, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
  join(root, "node_modules", "rcedit", "bin", "rcedit.exe"),
];
const rcedit = rceditCandidates.find((c) => c && existsSync(c));
const appIcon = join(root, "resources", "icons", "app.ico");
if (rcedit) {
  for (const rel of ["bin/launcher.exe", "bin/bun.exe"]) {
    const target = join(stagingDir, rel);
    if (existsSync(target)) {
      run(`"${rcedit}" "${target}" --set-icon "${appIcon}"`, root);
    }
  }
} else {
  console.warn("rcedit not found; app binaries will ship without an embedded icon");
}

// 3. Compile the NSIS installer.
run(`"${findMakensis()}" installer.nsi`, scriptsDir);

const installer = join(artifactsDir, "DeepSeek Harness-Installer.exe");
if (existsSync(installer)) {
  console.log(`\nGraphical installer: ${installer}`);
} else {
  console.error("error: installer was not produced");
  process.exit(1);
}
