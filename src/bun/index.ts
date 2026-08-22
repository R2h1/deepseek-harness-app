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
import { dlopen, FFIType, type Pointer } from "bun:ffi";
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
import { MobileAccessService } from "./mobile-access";

const WINDOW_WIDTH = 1600;
const WINDOW_HEIGHT = 920;
const READY_TIMEOUT_MS = 120_000;

let mainWindow: BrowserWindow | null = null;
let mobileWindow: BrowserWindow | null = null;
let backendProc: Bun.Subprocess | null = null;
let backendUrl: string | null = null;
let quitting = false;
let trayAvailable = false;
let notifiedCloseToTray = false;

/** First-party "phone access": LAN proxy + status server, run entirely in the shell. */
const mobileAccess = new MobileAccessService();

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
  setupWindowIcon();
  win.on("close", () => {
    info("main window closed; app stays in the tray");
    mainWindow = null;
    if (!notifiedCloseToTray) {
      notifiedCloseToTray = true;
      try {
        Utils.showNotification({
          title: "DeepSeek Harness is still running",
          body: "The window is closed, but the engine keeps running in the background. Click the tray icon to reopen.",
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
  // Mobile access: expose the engine on the LAN via a shell-side proxy.
  try {
    const port = Number(new URL(url).port);
    if (port > 0) void mobileAccess.start(port);
  } catch (err) {
    warn(`mobile access start: ${String(err)}`);
  }
}

const MOBILE_WINDOW_WIDTH = 560;
const MOBILE_WINDOW_HEIGHT = 720;

/** Open (or bring back) the "Mobile Access" window — a small phone-style window
 *  served by the shell's status server. */
function openMobileWindow(): void {
  const port = mobileAccess.mobileUiPort;
  if (!port) {
    warn("mobile access: engine not ready yet");
    return;
  }
  if (mobileWindow) {
    mobileWindow.show();
    mobileWindow.activate();
    return;
  }
  let frame = { x: 0, y: 0, width: MOBILE_WINDOW_WIDTH, height: MOBILE_WINDOW_HEIGHT };
  try {
    const work = Screen.getPrimaryDisplay().workArea;
    frame.x = work.x + Math.floor((work.width - MOBILE_WINDOW_WIDTH) / 2);
    frame.y = work.y + Math.floor((work.height - MOBILE_WINDOW_HEIGHT) / 2);
  } catch {
    // keep top-left default
  }
  const win = new BrowserWindow({
    title: "Mobile Access · 手机访问",
    frame,
    url: `http://127.0.0.1:${port}/mobile`,
    html: null,
    sandbox: true,
  });
  mobileWindow = win;
  win.on("close", () => {
    mobileWindow = null;
  });
  win.show();
}

/** Resolve a bundled asset under Resources/app/<subdir> (prod) or resources/<subdir> (dev). */
function resolveBundledAsset(subdir: string, name: string): string | null {
  const candidates = [
    join(resolve(process.cwd(), "../Resources/app"), subdir, name),
    join(process.cwd(), "resources", subdir, name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The tray icon path: bundled app asset first, project asset in dev. Windows
 *  tray needs an .ico; macOS uses a PNG template. */
function resolveTrayIcon(): string {
  const name = process.platform === "win32" ? "tray.ico" : "tray.png";
  const candidates = [
    join(resolve(process.cwd(), "../Resources/app"), name),
    join(process.cwd(), "resources", "icons", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** The app icon (.ico) for the native window title bar / taskbar: bundled
 *  `Resources/app.ico` in production, `resources/icons/app.ico` in dev. */
function resolveAppIconPath(): string {
  const candidates = [
    join(resolve(process.cwd(), "../Resources"), "app.ico"),
    join(process.cwd(), "resources", "icons", "app.ico"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * electrobun's BrowserWindow has no icon option and registers its window class
 * without an icon, so on Windows the title bar falls back to a generic icon
 * (the DeepSeek logo stays invisible even though it is embedded in bun.exe).
 *
 * Fix: set the window icon ourselves via user32 — LoadImageW the app.ico and
 * send WM_SETICON (ICON_BIG + ICON_SMALL) to the window — which is exactly what
 * WM_SETICON-based window icon APIs do. Windows-only, best-effort.
 *
 * Strings are passed to the W APIs as UTF-16LE Buffers (typed `pointer`): bun:ffi
 * CString-as-arg is unreliable on Windows in current Bun, and W functions need
 * UTF-16 anyway.
 */
function setupWindowIcon(): void {
  if (process.platform !== "win32") return;

  const lib = {
    FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    LoadImageW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.ptr,
    },
    SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  } as const;

  let user32: ReturnType<typeof dlopen<typeof lib>> | null = null;
  try {
    user32 = dlopen("user32.dll", lib);
  } catch (err) {
    warn(`window icon: user32 unavailable: ${String(err)}`);
    return;
  }

  const iconPath = resolveAppIconPath();
  if (!iconPath) {
    warn("window icon: app.ico not found; title bar keeps the default icon");
    return;
  }

  /** UTF-16LE NUL-terminated buffer for the W-API string parameters. */
  const wide = (s: string): Buffer => Buffer.from(`${s}\0`, "utf16le");

  /** @returns whether the window was found and the icon applied. */
  const apply = (): boolean => {
    const hwnd = user32!.symbols.FindWindowW(0 as Pointer, wide("DeepSeek Harness") as unknown as Pointer);
    if (!hwnd) return false;
    const icoPath = wide(iconPath) as unknown as Pointer;
    const big = user32!.symbols.LoadImageW(0 as Pointer, icoPath, 1 /* IMAGE_ICON */, 32, 32, 0x10 /* LR_LOADFROMFILE */);
    const small = user32!.symbols.LoadImageW(0 as Pointer, icoPath, 1, 16, 16, 0x10);
    if (big) user32!.symbols.SendMessageW(hwnd, 0x0080 /* WM_SETICON */, 1 as Pointer /* ICON_BIG */, big);
    if (small) user32!.symbols.SendMessageW(hwnd, 0x0080, 0 as Pointer /* ICON_SMALL */, small);
    return true;
  };

  try {
    if (!apply()) {
      // The native window is created synchronously by `new BrowserWindow`, so the
      // HWND is normally findable immediately; retry briefly just in case.
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (apply() || tries >= 20) clearInterval(timer);
      }, 50);
    }
  } catch (err) {
    warn(`window icon: ${String(err)}`);
  }
}

/**
 * Set the process AppUserModelID so the taskbar/right-click app name is
 * "DeepSeek Harness" instead of the exe's default ("Bun"). The exe version
 * strings are already set at build time; pinning the AUMID removes any
 * taskbar identity ambiguity (e.g. a cached "Bun" identity for bun.exe).
 */
function setAppUserModelId(): void {
  if (process.platform !== "win32") return;
  try {
    const shell32 = dlopen("shell32.dll", {
      SetCurrentProcessExplicitAppUserModelID: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const appId = "ai.deepseek.dsh-desktop";
    shell32.symbols.SetCurrentProcessExplicitAppUserModelID(
      Buffer.from(`${appId}\0`, "utf16le") as unknown as Pointer,
    );
  } catch (err) {
    warn(`app id: ${String(err)}`);
  }
}

/**
 * Ensure the Start Menu shortcut carries the AppUserModelID, so Windows
 * associates the taskbar identity with "DeepSeek Harness". Runs the bundled
 * set-aumid.exe helper (best-effort, idempotent). Covers manual copies and
 * installer installs alike.
 */
function ensureShortcutAppUserModelId(): void {
  if (process.platform !== "win32") return;
  try {
    const helper = resolveBundledAsset("win", "set-aumid.exe");
    if (!helper) return;
    const installDir = resolve(process.cwd(), "..");
    const lnk = join(
      process.env.APPDATA ?? "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "DeepSeek Harness",
      "DeepSeek Harness.lnk",
    );
    const target = join(installDir, "bin", "launcher.exe");
    void Bun.spawn(
      [helper, lnk, target, "ai.deepseek.dsh-desktop", target, "0"],
      { stdout: "ignore", stderr: "ignore" },
    ).exited.then((code) => {
      if (code !== 0) warn(`set-aumid helper exited ${code}`);
    });
  } catch (err) {
    warn(`set-aumid helper: ${String(err)}`);
  }
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
  void mobileAccess.dispose().catch(() => {});
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
    // English labels: electrobun 1.18.1's native Windows tray menu decodes
    // non-ASCII text with the ANSI codepage, which garbles CJK.
    { type: "normal", label: "Open DeepSeek Harness", action: "show" },
    { type: "divider" },
    { type: "normal", label: "Open in Browser", action: "open-browser" },
    { type: "normal", label: "Mobile Access", action: "mobile-access" },
    { type: "normal", label: "Restart Engine", action: "restart" },
    { type: "normal", label: "Check for Updates", action: "update-engine" },
    { type: "divider" },
    { type: "normal", label: "Quit", action: "quit" },
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
      case "mobile-access":
        openMobileWindow();
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

  setAppUserModelId();
  ensureShortcutAppUserModelId();
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
      Utils.showNotification({ title: "DeepSeek Harness", body: "Could not reach the update server.", silent: true });
    } catch {
      // notifications are best-effort
    }
    return;
  }
  if (latest === activeVersion) {
    try {
      Utils.showNotification({ title: "DeepSeek Harness", body: `Engine is up to date (${latest}).`, silent: true });
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
      body: updated ? `Engine updated to ${latest}; restarting…` : "Engine update failed; using the existing engine.",
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
