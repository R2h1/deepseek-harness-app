/**
 * DSH Desktop — ElectroBun main process.
 *
 * The shell supervises the real DeepSeek Harness backend (`dsh web`):
 *  - acquires the single-instance lock,
 *  - shows a branded loader window immediately,
 *  - spawns the backend with an OS-assigned port (`--port 0`) and discovers the
 *    served URL from the `dsh web: http://127.0.0.1:<port>` stdout line,
 *  - swaps the loader for the real GUI once the backend is ready,
 *  - keeps the app alive in the system tray when the window closes,
 *  - and tears the backend process tree down on quit.
 *
 * The dsh product itself is never modified: it still runs on Node with its own
 * native addons; this Bun process only starts, watches, and stops it.
 */
import { BrowserWindow, Screen, Tray, Utils } from "electrobun/bun";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { info, error, warn } from "./logger";
import { acquireSingleInstance } from "./single-instance";
import {
  consumeLines,
  killProcessTree,
  parseUrlLine,
  readActiveVersion,
  preferredBackendDir,
  readVersion,
  resolveBackendSpec,
  spawnBackend,
  type BackendSpec,
} from "./backend";
import { installBackend, queryNpmLatest } from "./updater";
import { errorHtml, loaderHtml } from "./loader-ui";

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const READY_TIMEOUT_MS = 120_000;

let mainWindow: BrowserWindow | null = null;
let backendProc: Bun.Subprocess | null = null;
let backendUrl: string | null = null;
let quitting = false;
let trayAvailable = false;
let notifiedCloseToTray = false;

/** App version, read from the bundle's version.json (dev falls back to a constant). */
function appVersion(): string {
  try {
    const raw = readFileSync(resolve(process.cwd(), "../Resources/version.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // dev run — fall through to the constant below
  }
  return "0.1.0";
}

/** Center the window on the primary display's work area. */
function centerFrame(): { x: number; y: number; width: number; height: number } {
  try {
    const work = Screen.getPrimaryDisplay().workArea;
    if (work.width >= WINDOW_WIDTH && work.height >= WINDOW_HEIGHT) {
      return {
        x: work.x + Math.floor((work.width - WINDOW_WIDTH) / 2),
        y: work.y + Math.floor((work.height - WINDOW_HEIGHT) / 2),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      };
    }
  } catch {
    // fall through to the default top-left position
  }
  return { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

/** Encode the loader page as a data: URL with an explicit UTF-8 charset. */
function loaderUrl(status?: string): string {
  const html = loaderHtml({
    appVersion: appVersion(),
    backendVersion: readActiveVersion(),
    status,
  });
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/** Encode the error page as a data: URL with an explicit UTF-8 charset. */
function errorUrl(message: string): string {
  const html = errorHtml({ message, appVersion: appVersion() });
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/** Create (or reuse) the main window. Loads the GUI URL when the backend is ready, else the loader. */
function ensureWindow(): BrowserWindow {
  if (mainWindow) return mainWindow;
  const frame = centerFrame();
  const win = new BrowserWindow({
    title: "DeepSeek Harness",
    frame,
    url: backendUrl ?? loaderUrl(),
    html: null,
    sandbox: true,
  });
  mainWindow = win;
  win.on("close", () => {
    info("main window closed; app stays in the tray");
    mainWindow = null;
    if (!notifiedCloseToTray) {
      notifiedCloseToTray = true;
      try {
        Utils.showNotification({
          title: "DeepSeek Harness 仍在运行",
          body: "窗口已关闭，引擎仍在后台运行。可点击系统托盘图标重新打开。",
          silent: true,
        });
      } catch {
        // notifications are best-effort
      }
    }
    if (!trayAvailable) shutdownAndQuit();
  });
  return win;
}

function showMainWindow(): void {
  const win = ensureWindow();
  win.show();
  win.activate();
}

function showErrorPage(message: string): void {
  error(message);
  const win = ensureWindow();
  win.webview.loadURL(errorUrl(message));
}

function openGui(url: string): void {
  const win = ensureWindow();
  win.webview.loadURL(url);
  win.setTitle("DeepSeek Harness");
  info(`GUI loaded at ${url}`);
}

/** The tray icon path: bundled app asset first, project asset in dev. */
function resolveTrayIcon(): string {
  const candidates = [
    join(resolve(process.cwd(), "../Resources/app"), "tray.png"),
    join(process.cwd(), "resources", "icons", "tray.png"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

async function stopBackend(): Promise<void> {
  const proc = backendProc;
  backendProc = null;
  if (proc) await killProcessTree(proc);
}

function shutdownAndQuit(): void {
  if (quitting) return;
  quitting = true;
  info("quitting: tearing down backend");
  void stopBackend().finally(() => Utils.quit());
}

async function restartBackend(): Promise<void> {
  info("restarting backend");
  await stopBackend();
  backendUrl = null;
  const win = ensureWindow();
  win.webview.loadURL(loaderUrl());
  void startBackendAndBoot();
}

function setupTray(): void {
  let tray: Tray;
  try {
    tray = new Tray({
      title: "DeepSeek Harness",
      image: resolveTrayIcon(),
      // template (monochrome) is a macOS-only concept; a color PNG shows blank
      // on Windows if template is set.
      template: process.platform === "darwin",
      width: 16,
      height: 16,
    });
  } catch (err) {
    warn(`system tray unavailable: ${String(err)}`);
    return;
  }
  trayAvailable = true;

  tray.setMenu([
    { type: "normal", label: "打开 DeepSeek Harness", action: "show" },
    { type: "divider" },
    { type: "normal", label: "在浏览器中打开", action: "open-browser" },
    { type: "normal", label: "重新启动引擎", action: "restart" },
    { type: "normal", label: "检查并更新引擎", action: "update-engine" },
    { type: "divider" },
    { type: "normal", label: "退出", action: "quit" },
  ]);

  tray.on("tray-clicked", (event) => {
    const data = (event as { data?: { action?: unknown } }).data;
    const action = typeof data?.action === "string" ? data.action : undefined;
    switch (action) {
      case "show":
        showMainWindow();
        break;
      case "open-browser":
        if (backendUrl) {
          Utils.openExternal(backendUrl);
        } else {
          warn("tray open-browser: backend not ready yet");
        }
        break;
      case "restart":
        void restartBackend();
        break;
      case "update-engine":
        void checkAndUpdateEngine();
        break;
      case "quit":
        shutdownAndQuit();
        break;
      default:
        // a plain tray-icon click (no menu action) brings the window back
        showMainWindow();
    }
  });
}

async function startBackendAndBoot(): Promise<void> {
  let spec: BackendSpec;
  try {
    spec = resolveBackendSpec();
  } catch (err) {
    showErrorPage(`无法解析后端启动方式：${String(err)}`);
    return;
  }

  let proc: Bun.Subprocess;
  try {
    proc = spawnBackend(spec);
  } catch (err) {
    showErrorPage(`无法启动 DeepSeek Harness 引擎：${String(err)}`);
    return;
  }
  backendProc = proc;

  let becameReady = false;
  proc.exited.then((code) => {
    if (quitting) return;
    error(`backend exited with code ${code}`);
    if (!becameReady && !backendUrl) {
      showErrorPage(
        `DeepSeek Harness 引擎意外退出（exit code ${code}），服务未能启动。\n可通过系统托盘「重新启动引擎」重试。`,
      );
    }
  });

  const onStdout = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length > 0) info(`backend: ${trimmed}`);
    const url = parseUrlLine(line);
    if (url && !becameReady) {
      becameReady = true;
      backendUrl = url;
      openGui(url);
    }
  };
  const onStderr = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length > 0) info(`backend/stderr: ${trimmed}`);
  };

  if (proc.stdout instanceof ReadableStream) {
    void consumeLines(proc.stdout, onStdout);
  }
  if (proc.stderr instanceof ReadableStream) {
    void consumeLines(proc.stderr, onStderr);
  }

  setTimeout(() => {
    if (!becameReady && !quitting) {
      showErrorPage(
        `引擎在 ${Math.floor(READY_TIMEOUT_MS / 1000)}s 内未能就绪。\n请检查网络与本地配置，或通过系统托盘重新启动引擎。`,
      );
    }
  }, READY_TIMEOUT_MS);
}

function main(): void {
  if (!acquireSingleInstance()) {
    console.log("DeepSeek Harness 已在运行，本实例将退出。");
    process.exit(0);
  }

  info(`=== DeepSeek Harness desktop ${appVersion()} starting (pid ${process.pid}) ===`);
  setupTray();
  void boot();
}

/**
 * Boot sequence: show the loader, check npm for a newer backend and install it
 * into the user-data directory when one exists, then start the backend (which
 * resolves through the same user-data-first order).
 */
async function boot(): Promise<void> {
  const win = ensureWindow();
  const renderLoader = (status: string): void => {
    if (!mainWindow) return;
    try {
      mainWindow.webview.loadURL(loaderUrl(status));
    } catch (err) {
      warn(`loader render failed: ${String(err)}`);
    }
  };

  renderLoader("正在检查引擎更新…");
  const latest = await queryNpmLatest();
  const active = preferredBackendDir();
  const activeVersion = active ? readVersion(active.dir) : null;

  if (latest && latest !== activeVersion) {
    info(`backend update available: ${activeVersion ?? "none"} -> ${latest}`);
    const updated = await installBackend(latest, renderLoader);
    if (!updated) {
      warn("backend update failed; booting the existing backend");
    }
  } else if (latest === activeVersion) {
    info(`backend is up to date (${latest})`);
  }

  renderLoader("正在启动引擎…");
  void startBackendAndBoot();
}

/** Tray action: check for a newer backend and, when found, install and restart. */
async function checkAndUpdateEngine(): Promise<void> {
  const latest = await queryNpmLatest();
  const active = preferredBackendDir();
  const activeVersion = active ? readVersion(active.dir) : null;
  if (!latest) {
    try {
      Utils.showNotification({ title: "DeepSeek Harness", body: "无法连接到更新服务器。", silent: true });
    } catch {
      // notifications are best-effort
    }
    return;
  }
  if (latest === activeVersion) {
    try {
      Utils.showNotification({ title: "DeepSeek Harness", body: `引擎已是最新版本（${latest}）。`, silent: true });
    } catch {
      // notifications are best-effort
    }
    return;
  }

  // Stop the running backend first: it may itself be using the user-data
  // backend directory, and installing into a locked node_modules would fail.
  await stopBackend();
  const updated = await installBackend(latest, () => {});
  try {
    Utils.showNotification({
      title: "DeepSeek Harness",
      body: updated ? `引擎已更新到 ${latest}，正在重启…` : "引擎更新失败，正在使用现有引擎。",
      silent: !updated,
    });
  } catch {
    // notifications are best-effort
  }
  backendUrl = null;
  const win = ensureWindow();
  win.webview.loadURL(loaderUrl("正在启动引擎…"));
  void startBackendAndBoot();
}

main();
