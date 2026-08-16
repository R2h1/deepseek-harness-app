#!/usr/bin/env node
/**
 * Compare the bundled backend version (resources/backend/VERSION) against the
 * latest @deepseek-ai/dsh on npm. Exit code 2 when an update is available.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = join(root, "resources", "backend", "VERSION");

let bundled;
try {
  bundled = readFileSync(versionPath, "utf8").trim();
} catch {
  console.error("尚未生成内置后端。请先运行 pnpm backend:provision。");
  process.exit(1);
}

let latest;
try {
  latest = execSync("npm view @deepseek-ai/dsh version", { encoding: "utf8" }).trim();
} catch (error) {
  console.error(`无法查询 npm 上的最新版本：${String(error)}`);
  process.exit(1);
}

console.log(`内置后端版本: ${bundled}`);
console.log(`npm 最新版本: ${latest}`);
if (bundled !== latest) {
  console.log("→ 有可用更新：运行 pnpm backend:provision 重新生成内置后端，然后重新打包即可。");
  process.exit(2);
} else {
  console.log("→ 已是最新。");
}
