#!/usr/bin/env node
/**
 * publish-release.mjs — one-command GitHub tag + release + asset upload.
 *
 * Tags the current commit, creates (or updates) a GitHub release, and uploads
 * the installer asset. Works without the `gh` CLI: it talks to the GitHub
 * REST API directly and reads a token from the Git credential manager
 * (Git Credential Manager / `git credential fill`), falling back to
 * GH_TOKEN / GITHUB_TOKEN.
 *
 * Usage:
 *   pnpm publish:release                          # tag v<package.json version> + release + upload
 *   pnpm publish:release -- --version 0.1.1       # explicit version
 *   pnpm publish:release -- --update              # patch title/body of an existing release
 *   pnpm publish:release -- --draft               # create as draft (publish manually later)
 *   pnpm publish:release -- --notes NOTES.md      # custom release body (markdown)
 *   pnpm publish:release -- --asset PATH          # different installer file
 *   pnpm publish:release -- --asset-name NAME     # override uploaded filename
 *   pnpm publish:release -- --no-upload           # tag + release only, skip asset
 *   pnpm publish:release -- --dry-run             # print the plan, change nothing
 *
 * Note on encoding: release notes are sent as UTF-8 bytes read from a file /
 * string and pushed with fetch(). Do NOT round-trip CJK text through a shell
 * (e.g. PowerShell) that may mangle it — this script never does.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GITHUB_HOST = process.env.DSH_DESKTOP_GITHUB_HOST || "github.com";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    version: null,
    update: false,
    draft: false,
    noUpload: false,
    dryRun: false,
    forceTag: false,
    asset: join(ROOT, "artifacts", "DeepSeek Harness-Installer.exe"),
    assetName: "deepseek-harness-app-installer.exe",
    notes: null,
    repo: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--version": opts.version = next(); break;
      case "--update": opts.update = true; break;
      case "--draft": opts.draft = true; break;
      case "--no-upload": opts.noUpload = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force-tag": opts.forceTag = true; break;
      case "--asset": opts.asset = next(); break;
      case "--asset-name": opts.assetName = next(); break;
      case "--notes": opts.notes = next(); break;
      case "--repo": opts.repo = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function run(cmd, args, opts = {}) {
  const { input } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runSync(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts }).trim();
  } catch (err) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function log(step, msg) {
  console.log(`\n=== ${step} ===\n${msg}`);
}

function versionToTag(v) {
  return v.startsWith("v") ? v : `v${v}`;
}

/* ------------------------------------------------------------------ */
/* Token (git credential manager → env fallback)                       */
/* ------------------------------------------------------------------ */

async function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = await run("git", ["credential", "fill"], { input: `protocol=https\nhost=${GITHUB_HOST}\n\n` });
    const m = out.match(/^password=(.+)$/m);
    if (m && m[1]) return m[1];
  } catch {
    /* fall through */
  }
  throw new Error(
    `No GitHub token found. Either:\n` +
    `  1. store one with Git Credential Manager (a normal HTTPS clone/push already does), or\n` +
    `  2. set GH_TOKEN or GITHUB_TOKEN.`,
  );
}

/* ------------------------------------------------------------------ */
/* Repo resolution                                                     */
/* ------------------------------------------------------------------ */

function getRepo(override) {
  if (override) return override;
  const url = runSync("git", ["remote", "get-url", "origin"]);
  const m = url.match(new RegExp(`${GITHUB_HOST.replace(/\./g, "\\.")}[/:]([^/]+)/([^/.]+)(\\.git)?$`));
  if (!m) throw new Error(`Could not parse owner/repo from origin: ${url}`);
  return `${m[1]}/${m[2]}`;
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

async function api(method, path, token, body) {
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "dsh-publish-release",
    Accept: "application/vnd.github+json",
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} -> ${msg}`);
  }
  return data;
}

/** Upload a file to a release (octet-stream), clobbering an asset of the same name first. */
async function uploadAsset(repo, releaseId, token, assetPath, assetName, dryRun) {
  if (dryRun) {
    log("UPLOAD", `[dry-run] would upload ${basename(assetPath)} (${statSync(assetPath).size} B) as "${assetName}"`);
    return `https://github.com/${repo}/releases/download/REPLACE_TAG/${encodeURIComponent(assetName)}`;
  }
  // Clobber: remove any existing asset with the same name.
  const rel = await api("GET", `/repos/${repo}/releases/${releaseId}`, token);
  const existing = (rel.assets || []).find((a) => a.name === assetName);
  if (existing) {
    log("CLEAN", `deleting existing asset "${existing.name}" (id ${existing.id})`);
    await api("DELETE", `/repos/${repo}/releases/assets/${existing.id}`, token);
  }

  log("UPLOAD", `uploading ${basename(assetPath)} (${statSync(assetPath).size} B) as "${assetName}" …`);
  const buf = readFileSync(assetPath);
  const url = `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "dsh-publish-release",
      "Content-Type": "application/octet-stream",
      Accept: "application/vnd.github+json",
    },
    body: buf,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`asset upload -> ${data?.message || `HTTP ${res.status}`}`);
  if (data.state !== "uploaded") throw new Error(`asset upload -> state ${data.state}`);
  return data.browser_download_url;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`DSH Desktop release publisher

Usage: pnpm publish:release -- [options]

Options:
  --version <v>     Version to release (default: package.json version)
  --update          Patch title/body of an already-published release
  --draft           Create as a draft (publish manually in the UI later)
  --no-upload       Tag + release only, skip the installer upload
  --force-tag       Move the tag if it already exists (overwrites remote tag)
  --asset <path>    Installer file to upload (default: artifacts/DeepSeek Harness-Installer.exe)
  --asset-name <n>  Uploaded filename (default: deepseek-harness-app-installer.exe)
  --notes <path>    Markdown file used as the release body
  --repo <o/r>      Override repo (default: parsed from git origin)
  --dry-run         Print the plan without changing anything
  --help            Show this help`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const tag = versionToTag(opts.version || pkg.version);
const repo = getRepo(opts.repo);

const defaultNotes = `## deepseek-harness-app ${tag}

### 简体中文

Windows 桌面版安装包（ElectroBun 外壳 + DeepSeek Harness Web GUI）。

**下载**
- **deepseek-harness-app-installer.exe** — 图形化安装向导（NSIS 3.x Unicode，简体中文界面）

**本版本**
- ElectroBun 桌面外壳（Bun 主进程 + WebView2）
- 自动拉取并托管 @deepseek-ai/dsh 后端引擎
- 安装器升级为 NSIS 3.x (Unicode) + 简体中文 UI，逐用户安装，桌面/开始菜单快捷方式，卸载入口
- 安装脚本 section 名保持英文，避免安全软件误伤（Lenovo/Huorong、AlibabaProtect 环境下已验证）

---

### English

Windows desktop installer (ElectroBun shell + DeepSeek Harness Web GUI).

**Download**
- **deepseek-harness-app-installer.exe** — graphical installer (NSIS 3.x Unicode, Simplified-Chinese UI)

**This release**
- ElectroBun desktop shell (Bun main process + WebView2)
- Automatically fetches and hosts the @deepseek-ai/dsh backend engine
- Installer upgraded to NSIS 3.x (Unicode) with a Simplified-Chinese UI: per-user install, desktop/Start Menu shortcuts, uninstall entry
- Installer section names kept in English to avoid false positives from security software (verified under Lenovo/Huorong and AlibabaProtect)
`;
const releaseBody = opts.notes ? readFileSync(opts.notes, "utf8") : defaultNotes;
const title = `deepseek-harness-app ${tag}`;

log("PLAN", [
  `repo      : ${repo}`,
  `tag       : ${tag}`,
  `title     : ${title}`,
  `body      : ${opts.notes ? `from ${opts.notes}` : "default template"}`,
  `asset     : ${opts.asset} -> ${opts.assetName}`,
  `draft     : ${opts.draft}`,
  `update    : ${opts.update}`,
  `dry-run   : ${opts.dryRun}`,
].join("\n"));

/* --- 1. tag --- */
if (!opts.dryRun) {
  let tagExists = true;
  try {
    runSync("git", ["rev-parse", tag]);
  } catch {
    tagExists = false;
  }
  if (!tagExists) {
    log("TAG", `creating annotated tag ${tag}`);
    runSync("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
    log("TAG", `pushing ${tag} to origin`);
    runSync("git", ["push", "origin", tag]);
  } else {
    if (opts.forceTag) {
      log("TAG", `tag ${tag} exists — force-moving to HEAD and pushing (--force-tag)`);
      runSync("git", ["tag", "-f", "-a", tag, "-m", `Release ${tag}`]);
      runSync("git", ["push", "-f", "origin", tag]);
    } else {
      log("TAG", `tag ${tag} already exists — reusing it (use --force-tag to move it)`);
    }
  }
} else {
  log("TAG", "[dry-run] would ensure tag " + tag);
}

if (opts.dryRun) {
  log("DONE", "dry-run finished — nothing was changed.");
  process.exit(0);
}

/* --- 2. token + release --- */
const token = await getToken();
let release;
let created = false;
try {
  release = await api("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
  log("RELEASE", `release for ${tag} already exists (id ${release.id})`);
} catch {
  created = true;
}

if (created) {
  log("RELEASE", `creating release ${tag}`);
  release = await api("POST", `/repos/${repo}/releases`, token, {
    tag_name: tag,
    name: title,
    body: releaseBody,
    draft: opts.draft,
    prerelease: false,
  });
} else if (opts.update) {
  log("RELEASE", `updating release ${tag} (--update)`);
  release = await api("PATCH", `/repos/${repo}/releases/${release.id}`, token, {
    name: title,
    body: releaseBody,
    draft: opts.draft,
  });
}

/* --- 3. asset --- */
let downloadUrl = null;
if (!opts.noUpload) {
  if (!opts.dryRun && !existsSafe(opts.asset)) {
    throw new Error(`installer not found: ${opts.asset} — run \`pnpm build:installer\` first`);
  }
  downloadUrl = await uploadAsset(repo, release.id, token, opts.asset, opts.assetName, opts.dryRun);
}

/* --- 4. summary --- */
log("DONE", [
  `release : ${release.html_url}`,
  downloadUrl ? `download: ${downloadUrl}` : "download: (no asset uploaded)",
  `title   : ${release.name}`,
  `draft   : ${release.draft}`,
].join("\n"));

function existsSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
