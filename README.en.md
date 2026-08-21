# DSH Desktop

[简体中文](README.md) | **English**

A native desktop shell for DeepSeek Harness, built on [ElectroBun](https://electrobun.dev).

No more opening a terminal and running `dsh web` first: double-click the app, and it
starts the DeepSeek Harness engine in the background, opens the full GUI in a native
window once the port is ready, and cleanly stops the engine on exit.

> This app is only a shell around the engine and is fully decoupled from the
> deepseek-harness repository: **the engine comes from the latest `@deepseek-ai/dsh`
> on npm** and still runs on Node.

---

## Features

- **Works out of the box**: double-click to launch — the engine starts in the
  background and the GUI opens automatically, no terminal needed.
- **Auto-tracks the latest engine**: on every launch it checks npm for the newest
  `@deepseek-ai/dsh` and, when a newer version exists, downloads and installs it into
  the user-data directory (bundled pnpm + Node) — the next launch uses the newest
  version **without ever repackaging**. Falls back gracefully to the bundled offline
  engine when offline.
- **Self-contained backend**: `pnpm backend:provision` bundles a copy of
  `@deepseek-ai/dsh` plus a Node runtime into the app as an **offline fallback**, so
  new machines work without a network.
- **Dynamic port**: starts with `dsh web --port 0` (OS-assigned port) and parses the
  real address from the `dsh web: http://…` output line — no more conflicts with a
  fixed 3080 port (e.g. another Harness already running).
- **Branded startup page**: the window first shows a loader (with update progress),
  then switches to the real GUI once the engine is ready.
- **System tray**: open window / open in browser / restart engine / check & update
  engine / quit; closing the window keeps the app in the tray and the engine running.
- **Single instance**: a named mutex on Windows (auto-released on process exit), a PID
  lock file on other platforms.
- **Clean exit**: terminates the engine process tree with `taskkill /T` on quit.

---

## Installation & Usage (users)

### Download & install

Download from [Releases](https://github.com/R2h1/deepseek-harness-app/releases):

| Package | Description |
|---|---|
| `deepseek-harness-app-installer.exe` | **Recommended**: graphical install wizard (Simplified-Chinese UI). Installs by default to `%LOCALAPPDATA%\Programs\DeepSeek Harness`, creates Desktop/Start Menu shortcuts, registers an uninstall entry |
| `DeepSeek Harness-Setup.exe` | Single-file self-extracting package (no wizard) |
| `*.zip` | Raw distribution (needs extraction) |

### First launch

- On first launch the app checks npm and installs the latest engine (~200 MB online
  download; offline it uses the bundled engine directly).
- Requires Windows 10/11 (WebView2 runtime built in; very old systems may need
  [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)).

### Configure your API key

- Configure it in the app UI (Settings → models/providers), or set the environment
  variable `DEEPSEEK_API_KEY`.
- The program is fully self-contained — no Node / npm / pnpm install required.

### Daily use

- **System tray**: open window / open in browser / restart engine / **check & update
  engine** / quit; closing the window keeps the app in the tray and the engine running.
- **Engine auto-track**: on each launch the app checks npm and installs the latest
  engine into the user-data directory — no manual repackaging needed.
- **Uninstall**: Settings → Apps → DeepSeek Harness → Uninstall (or run
  `Uninstall.exe` in the install directory).

### Data & sessions

- Your conversations live on disk at `~/.dsh/sessions/` (per project).
- **None of the tray actions** (open window / open in browser / restart engine / check
  for updates) delete sessions; after a restart or update, sessions reload from disk.
- ⚠️ The only caveat: **an in-flight reply** is interrupted if you restart or update
  the engine at that moment (the unfinished part is lost; everything already completed
  stays).
- Uninstalling **does not delete** `~/.dsh` — your sessions and config are kept; delete
  that directory manually to fully clean up.
- To back up or migrate: just copy the whole `~/.dsh` directory.

### Notes & FAQ

- **Antivirus false positives**: on machines with Lenovo/Huorong or AlibabaProtect,
  installed files were once automatically wiped right after install — the installer
  now uses English section names to avoid it. If your files still get removed, add the
  installer/install directory to the whitelist.
- **Engine follows `latest` only**: only the npm `latest` tag is auto-installed;
  pre-releases (`next`, e.g. rc.8) are not auto-installed until they are promoted to
  `latest`, which the next launch picks up automatically.
- **SmartScreen prompt**: the installer is unsigned; on first run click
  "More info → Run anyway".
- **First launch is slow**: it downloads the latest engine online (~200 MB, network
  dependent).

### Known limitations

- Closing the main window keeps the app in the tray; if the tray fails to create,
  closing the window exits the app instead.
- macOS uses WKWebView (Safari engine); the dsh frontend behavior has not been verified
  in that environment.
- The shell's own update (ElectroBun `Updater` / bsdiff delta) is not wired up yet —
  the engine version already tracks automatically.

---

## Development (developers)

### Prerequisites

- [Bun](https://bun.sh) (build/dev toolchain)
- Windows 10/11 (Edge WebView2 runtime, preinstalled); macOS/Linux builds are supported
  but not verified
- Using the models requires a `DEEPSEEK_API_KEY` (reuses your `~/.dsh` and `.env`)

### Quick start

```sh
bun install
bun start          # run the built app (or bun dev: build and run)
bun run dev:watch  # auto-rebuild on changes
```

In dev mode the backend boots from the adjacent `../deepseek-harness` source checkout
(equivalent to `node --import tsx/esm apps/cli/src/bin.ts web --port 0`) for fast iteration.

### Architecture

```
DSH Desktop (ElectroBun)
  ├─ Main process (Bun): src/bun/index.ts
  │    ├─ single-instance check
  │    ├─ resolve backend source (bundled → local source → npx fallback)
  │    ├─ spawn dsh web --port 0 (parse URL line from stdout)
  │    ├─ loader window → loadURL(real GUI) once ready
  │    └─ tray / close-to-tray / kill process tree on exit
  └─ Backend (unmodified): @deepseek-ai/dsh web, running on Node + its native addons
```

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `DSH_DESKTOP_BACKEND_DIR` | bundled `resources/backend` | explicitly set the backend directory |
| `DSH_DESKTOP_NODE` | bundled `resources/node`, else PATH | explicitly set the Node executable |
| `DSH_DESKTOP_DEV_BACKEND` | `../deepseek-harness` | dev source checkout path |
| `DSH_DESKTOP_USER_DATA` | `%LOCALAPPDATA%\dsh-desktop` etc. | logs and single-instance lock dir |

### Bundled backend (offline fallback)

```sh
pnpm backend:provision   # install the latest @deepseek-ai/dsh into resources/backend, plus Node + pnpm
pnpm backend:pin 0.1.0-rc.6   # pin a specific version
pnpm backend:check       # compare bundled vs npm latest (exit code 2 when an update is available)
pnpm gen:icons           # regenerate tray/app icons
```

`resources/backend/VERSION` records the bundled version. **No manual repackaging is
needed for daily use**: on launch the app checks npm for the latest version and installs
it to `%LOCALAPPDATA%\dsh-desktop\backend`; re-running `backend:provision` only refreshes
this offline fallback (e.g. when distributing to offline machines).

### Packaging

```sh
pnpm build:stable      # build artifacts/ output + Setup.zip
pnpm build:installer   # graphical NSIS installer: artifacts/DeepSeek Harness-Installer.exe
pnpm build:portable    # single-file self-extracting package: artifacts/DeepSeek Harness-Setup.exe
```

`build:installer` requires [NSIS](https://nsis.sourceforge.io) (`makensis`; set
`DSHP_NSIS_MAKENSIS` to the path, or add it to PATH). macOS builds must be produced on
macOS (ElectroBun builds for the current machine).

### Publishing (tag + release + upload)

```sh
pnpm publish:release                     # tag v<package.json version> + release + upload installer
pnpm publish:release -- --version 0.1.1  # explicit version
pnpm publish:release -- --update         # update an existing release's title/body
pnpm publish:release -- --draft          # create as a draft, publish manually in the UI
pnpm publish:release -- --notes NOTES.md # custom release body (markdown)
pnpm publish:release -- --dry-run        # print the plan, change nothing
```

- Resolves the repo from `git remote origin` and takes the token from the Git credential
  manager (or `GH_TOKEN`).
- The default body is a **bilingual template (Chinese first, English below)**; all text
  goes over the REST API as UTF-8 (never through a shell), so CJK never turns into `?`.
- The uploaded filename is fixed to `deepseek-harness-app-installer.exe` (an existing
  asset with the same name is replaced).
- Full docs: `node scripts/publish-release.mjs --help`.
