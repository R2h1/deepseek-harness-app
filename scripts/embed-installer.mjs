#!/usr/bin/env node
/**
 * Produce a single, double-clickable Windows installer by embedding the app
 * payload into the extractor binary.
 *
 * The Windows `extractor.exe` supports the same magic-marker embedding the
 * Linux installer path uses, so the built Setup.exe, its metadata, and the
 * compressed archive can be fused into one self-contained exe — no `.installer`
 * folder and no unzip step for the end user.
 *
 * Layout: <extractor> ELECTROBUN_METADATA_V1 <metadata json> ELECTROBUN_ARCHIVE_V1 <archive>
 *
 * Run after `pnpm build:stable`; the single file lands in artifacts/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildFolder = join(root, "build", "stable-win-x64");
const artifactsDir = join(root, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const METADATA_MARKER = Buffer.from("ELECTROBUN_METADATA_V1", "utf8");
const ARCHIVE_MARKER = Buffer.from("ELECTROBUN_ARCHIVE_V1", "utf8");

const exePath = join(buildFolder, "DeepSeek Harness-Setup.exe");
const metadataPath = join(buildFolder, "DeepSeek Harness-Setup.metadata.json");
const archivePath = join(buildFolder, "DeepSeek Harness-Setup.tar.zst");

for (const [label, path] of [["extractor", exePath], ["metadata", metadataPath], ["archive", archivePath]]) {
  if (!existsSync(path)) {
    console.error(`error: ${label} not found at ${path}; run \`pnpm build:stable\` first`);
    process.exit(1);
  }
}

const extractor = readFileSync(exePath);
// Compact JSON, matching the Linux embedding format the extractor is built for.
const metadata = Buffer.from(JSON.stringify(JSON.parse(readFileSync(metadataPath, "utf8"))), "utf8");
const archive = readFileSync(archivePath);

const combined = Buffer.concat([extractor, METADATA_MARKER, metadata, ARCHIVE_MARKER, archive]);
const outPath = join(artifactsDir, "DeepSeek Harness-Setup.exe");
writeFileSync(outPath, combined);
console.log(
  `Wrote single-file installer: ${outPath} (${(combined.length / 1024 / 1024).toFixed(1)} MB)`,
);
