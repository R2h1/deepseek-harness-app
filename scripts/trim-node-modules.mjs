#!/usr/bin/env node
/**
 * Conservatively prune a node_modules tree of files that are never needed at
 * runtime, to shrink installs. Only safe categories are removed:
 *  - TypeScript/build artifacts: *.d.ts, *.map, *.tsbuildinfo, *.orig, *.rej
 *  - documentation: *.md and README/LICENSE/CHANGELOG/AUTHORS/... files
 *  - docs/examples/test/benchmark directories
 *  - prebuilds for platforms other than the current one
 *
 * Usage: node trim-node-modules.mjs <node_modules-dir>
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node trim-node-modules.mjs <node_modules-dir>");
  process.exit(1);
}

const PLATFORM = `${process.platform}-${process.arch}`; // e.g. win32-x64

const FILE_RE = /\.(d\.ts|tsbuildinfo|map|md|orig|rej)$/i;
const DOC_FILE_RE = /^(readme|license|licence|changelog|authors|contributing|copying|notice|security|code_of_conduct)(\.|$)/i;
// Only plural/compound forms — `doc`/`example` singular are runtime subdirs in
// many packages (e.g. yaml/dist/doc) and must never be removed.
const DIR_RE = /^(docs|examples|tests|__tests__|benchmarks|\.github)$/i;

let removedFiles = 0;
let removedBytes = 0;
let removedDirs = 0;

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  } catch {
    // unreadable dir — count as zero
  }
  return total;
}

function fmt(bytes) {
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" && full !== root) continue; // hoisted nested trees are handled at the root walk
      if (DIR_RE.test(entry.name)) {
        const size = dirSize(full);
        rmSync(full, { recursive: true, force: true });
        removedDirs++;
        removedBytes += size;
        console.log(`- dir ${full.slice(root.length)} (${fmt(size)})`);
        continue;
      }
      if (entry.name === "prebuilds") {
        for (const sub of readdirSync(full, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name !== PLATFORM) {
            const size = dirSize(join(full, sub.name));
            rmSync(join(full, sub.name), { recursive: true, force: true });
            removedDirs++;
            removedBytes += size;
            console.log(`- prebuild ${sub.name} (${fmt(size)})`);
          }
        }
        continue; // never descend into prebuilds contents
      }
      walk(full);
    } else if (entry.isFile()) {
      if (FILE_RE.test(entry.name) || DOC_FILE_RE.test(entry.name)) {
        removedFiles++;
        removedBytes += stat.size;
        rmSync(full, { force: true });
      }
    }
  }
}

walk(root);
console.log(
  `\nTrimmed ${removedFiles} files (${fmt(removedBytes)}) and ${removedDirs} directories under ${root}`,
);
