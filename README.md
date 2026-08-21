# DSH Desktop

**简体中文** | [English](README.en.md)

DeepSeek Harness 桌面端 —— 基于 [ElectroBun](https://electrobun.dev) 的原生桌面壳。

双击即可使用，不用再开终端跑 `dsh web`：应用自动在后台启动 DeepSeek Harness 引擎、
等端口就绪后在原生窗口里打开完整 GUI，退出时干净地停掉引擎。

> 本应用只是引擎的外壳，与 deepseek-harness 仓库完全解耦：**引擎来自 npm 上最新的
> `@deepseek-ai/dsh`**，仍跑在 Node 上。

---

## 功能特性

- **开箱即用**：双击启动，自动在后台拉起引擎并打开 GUI，无需手动开终端。
- **自动跟进最新引擎**：每次启动检查 npm 上的最新 `@deepseek-ai/dsh`，发现新版本就自动
  下载安装到用户数据目录（内置 pnpm + Node），下次启动直接用最新版——**不需要重新打包**；
  离线时优雅回退到应用内置的离线引擎。
- **自包含后端**：`pnpm backend:provision` 把一份 `@deepseek-ai/dsh` 和 Node 运行时打进
  应用作为**离线兜底**，新机器无网络也能用。
- **动态端口**：以 `dsh web --port 0` 启动（OS 分配端口），从输出行解析真实地址——不会再
  撞上固定 3080 端口（比如另一个正在运行的 Harness）。
- **品牌化启动页**：窗口先显示加载页（含更新进度），引擎就绪后自动切换到真实 GUI。
- **系统托盘**：打开窗口 / 在浏览器中打开 / 重新启动引擎 / 检查并更新引擎 / 退出；关闭窗口
  后应用驻留托盘，引擎继续运行。
- **单实例**：Windows 用命名互斥量（进程退出自动释放），其余平台用 PID 锁文件。
- **干净退出**：退出时用 `taskkill /T` 终止引擎进程树。

---

## 安装使用（用户）

### 下载安装

从 [Releases](https://github.com/R2h1/deepseek-harness-app/releases) 下载：

| 包 | 说明 |
|---|---|
| `deepseek-harness-app-installer.exe` | **推荐**：图形化安装向导（简体中文 UI）。默认装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，创建桌面/开始菜单快捷方式，注册卸载项 |
| `DeepSeek Harness-Setup.exe` | 单文件自解压包（无向导） |
| `*.zip` | 原始分发包（需解压） |

### 首次启动

- 首次启动会自动检查并从 npm 安装最新引擎（在线约 200MB 下载；离线直接用内置引擎）。
- 需要 Windows 10/11（系统自带 WebView2 运行时；很老的系统可能缺，需装
  [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)）。

### 配置 API Key

- 在应用界面按引导配置（设置 → 模型/提供商），或设置环境变量 `DEEPSEEK_API_KEY`。
- 程序完全自包含，不需要装 Node / npm / pnpm。

### 日常使用

- **系统托盘**：打开窗口 / 在浏览器中打开 / 重新启动引擎 / **检查并更新引擎** / 退出；
  关闭窗口后应用驻留托盘，引擎继续运行。
- **引擎自动跟进**：每次启动检查 npm 最新版并自动安装到用户数据目录，无需手动重打包。
- **卸载**：设置 → 应用 → DeepSeek Harness → 卸载（或运行安装目录下的 `Uninstall.exe`）。

### 数据与会话

- 你的对话数据存在磁盘上：`~/.dsh/sessions/`（按项目分目录）。
- 托盘里的任何操作（打开窗口 / 打开浏览器 / 重新启动引擎 / 检查更新）**都不会删除**会话；
  重启或更新后，会话会自动从磁盘重新加载。
- ⚠️ 唯一注意：**正在生成中的回复**，如果此时重启或更新引擎，这条回复会被中断
  （未生成完的部分会丢失，之前已完成的都在）。
- 卸载程序**不会删除** `~/.dsh`——你的会话和配置都会保留；如需彻底清除请手动删除该目录。
- 想备份/迁移：直接整体拷贝 `~/.dsh` 即可。

### 注意点（常见问题）

- **安全软件误报**：装有联想杀毒（Lenovo/Huorong）、阿里（AlibabaProtect）等安全软件的机器上，
  曾出现安装后文件被自动清理的情况——安装脚本已改用英文 section 名规避。若你的文件仍被清理，
  请把安装包/安装目录加入白名单。
- **引擎只跟随 `latest`**：只自动安装 npm `latest` 标签的版本；预发布（`next`，例如 rc.8）
  不会自动安装，等转正后下次启动自动跟进。
- **SmartScreen 提示**：安装包未签名，首次运行需点"更多信息 → 仍要运行"。
- **首次启动较慢**：需要在线下载最新引擎（约 200MB，视网络而定）。

### 已知限制

- 关闭主窗口后应用驻留托盘；如系统托盘创建失败，关闭窗口会直接退出。
- macOS 用 WKWebView（Safari 内核），尚未在此环境验证 dsh 前端行为。
- 应用外壳自身更新（ElectroBun `Updater` / bsdiff 增量）尚未接入——引擎版本已自动跟进。

---

## 开发（开发者）

### 环境需求

- [Bun](https://bun.sh)（构建/开发工具链）
- Windows 10/11（Edge WebView2 运行时，系统已预装）；macOS/Linux 架构兼容但未验证
- 使用模型需要 `DEEPSEEK_API_KEY`（沿用你的 `~/.dsh` 与 `.env`）

### 快速开始

```sh
bun install
bun start          # 运行已构建的应用（或 bun dev：构建并运行）
bun run dev:watch  # 改动自动重建
```

开发态默认从相邻的 `../deepseek-harness` 源码 checkout 启动后端（等价于
`node --import tsx/esm apps/cli/src/bin.ts web --port 0`），方便迭代。

### 架构

```
DSH Desktop (ElectroBun)
  ├─ 主进程 (Bun): src/bun/index.ts
  │    ├─ 单实例检查
  │    ├─ 解析后端来源（内置 → 本地源码 → npx 兜底）
  │    ├─ spawn dsh web --port 0（stdout 解析 URL 行）
  │    ├─ 加载页窗口 → 就绪后 loadURL(真实 GUI)
  │    └─ 托盘 / 关闭到托盘 / 退出时 kill 进程树
  └─ 后端（未改动）: @deepseek-ai/dsh web，跑在 Node + 自带原生插件上
```

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_DESKTOP_BACKEND_DIR` | 内置 `resources/backend` | 显式指定后端目录 |
| `DSH_DESKTOP_NODE` | 内置 `resources/node`，否则 PATH | 显式指定 Node 可执行文件 |
| `DSH_DESKTOP_DEV_BACKEND` | `../deepseek-harness` | 开发用的源码 checkout 路径 |
| `DSH_DESKTOP_USER_DATA` | `%LOCALAPPDATA%\dsh-desktop` 等 | 日志与单实例锁目录 |

### 内置后端（离线兜底）

```sh
pnpm backend:provision   # 安装 npm 最新 @deepseek-ai/dsh 到 resources/backend，并拷贝 Node 运行时 + pnpm
pnpm backend:pin 0.1.0-rc.6   # 固定一个具体版本
pnpm backend:check       # 对比内置版本与 npm 最新版（有新版本时退出码 2）
pnpm gen:icons           # 重新生成托盘/应用图标
```

`resources/backend/VERSION` 记录内置版本。**日常使用不需要手动重打包**：应用启动时会自动检查
npm 上的最新版并安装到 `%LOCALAPPDATA%\dsh-desktop\backend`；重新执行 `backend:provision`
只是为了刷新这份离线兜底（比如给离线机器分发时）。

### 打包

```sh
pnpm build:stable      # 产出 artifacts/ 下的构建产物 + Setup.zip
pnpm build:installer   # 产出图形化 NSIS 安装程序：artifacts/DeepSeek Harness-Installer.exe
pnpm build:portable    # 产出单文件自解压包：artifacts/DeepSeek Harness-Setup.exe
```

`build:installer` 需要 [NSIS](https://nsis.sourceforge.io)（`makensis`；可用
`DSHP_NSIS_MAKENSIS` 指定路径，或加入 PATH）。macOS 构建必须在 macOS 上进行
（ElectroBun 面向当前机器系统构建）。

### 发布（打 tag + release + 传安装包）

```sh
pnpm publish:release                     # tag v<package.json version> + release + 上传安装包
pnpm publish:release -- --version 0.1.1  # 指定版本
pnpm publish:release -- --update         # 更新已有 release 的标题/描述
pnpm publish:release -- --draft          # 先建草稿，网页手动发布
pnpm publish:release -- --notes NOTES.md # 自定义 release 描述（markdown）
pnpm publish:release -- --dry-run        # 只打印计划，不改任何东西
```

- 自动解析 `git remote origin` 得到仓库，从 Git 凭据管理器取 token（或 `GH_TOKEN`）。
- 描述默认是**中英双语模板（中文在前、英文在后）**；所有文本以 UTF-8 直接走 REST API，
  不经过 shell，不会再出现中文变 `?` 的问题。
- 上传文件名固定为 `deepseek-harness-app-installer.exe`（同名旧资产会被覆盖）。
- 完整说明：`node scripts/publish-release.mjs --help`。
