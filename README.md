# DSH Desktop

DeepSeek Harness 桌面端 —— 基于 [ElectroBun](https://electrobun.dev) 的原生桌面壳。

不再需要先开终端跑 `dsh web`：双击应用，它自动在后台启动 DeepSeek Harness 引擎、
等端口就绪后在原生窗口里打开完整 GUI，退出时干净地停掉引擎。

与 deepseek-harness 仓库完全解耦：本应用只是引擎的外壳，**内置的后端来自 npm 上最新的
`@deepseek-ai/dsh`**，每次发新版重新打包即可跟进，引擎自身仍跑在 Node 上。

## 特性

- **自包含后端**：`pnpm backend:provision` 把最新 `@deepseek-ai/dsh` 和一份 Node 运行时
  打进应用，新机器无需安装 Node / npm。
- **动态端口**：以 `dsh web --port 0` 启动（OS 分配端口），从 `dsh web: http://…` 输出行
  解析真实地址——不会再撞上固定 3080 端口（比如另一个正在运行的 Harness）。
- **启动加载页**：打开窗口先显示品牌化启动页，引擎就绪后自动切换到真实 GUI。
- **系统托盘**：打开窗口 / 在浏览器中打开 / 重新启动引擎 / 退出；关闭窗口后应用留在托盘，
  引擎继续运行。
- **单实例**：Windows 用命名互斥量（进程退出自动释放），其余平台用 PID 锁文件。
- **干净退出**：退出时用 `taskkill /T` 终止引擎进程树。
- **版本跟踪**：`pnpm backend:check` 对比内置后端与 npm 最新版。

## 架构

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

## 需求

- [Bun](https://bun.sh)（构建/开发工具链）
- Windows 10/11（Edge WebView2 运行时，系统已预装）；macOS/Linux 架构兼容但未验证
- 实际使用模型需要 `DEEPSEEK_API_KEY`（沿用你的 `~/.dsh` 与 `.env`）

## 开发

```sh
bun install
bun start          # 运行已构建的应用（或 bun dev：构建并运行）
bun run dev:watch  # 改动自动重建
```

开发态默认从相邻的 `../deepseek-harness` 源码 checkout 启动后端（等价于
`node --import tsx/esm apps/cli/src/bin.ts web --port 0`），方便迭代。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_DESKTOP_BACKEND_DIR` | 内置 `resources/backend` | 显式指定后端目录 |
| `DSH_DESKTOP_NODE` | 内置 `resources/node`，否则 PATH | 显式指定 Node 可执行文件 |
| `DSH_DESKTOP_DEV_BACKEND` | `../deepseek-harness` | 开发用的源码 checkout 路径 |
| `DSH_DESKTOP_USER_DATA` | `%LOCALAPPDATA%\dsh-desktop` 等 | 日志与单实例锁目录 |

## 内置后端（跟进最新）

```sh
pnpm backend:provision   # 安装 npm 最新 @deepseek-ai/dsh 到 resources/backend，并拷贝 Node 运行时
pnpm backend:pin 0.1.0-rc.6   # 固定一个具体版本
pnpm backend:check       # 对比内置版本与 npm 最新版（有新版本时退出码 2）
pnpm gen:icons           # 重新生成托盘/应用图标
```

`resources/backend/VERSION` 记录内置版本，加载页底部会显示。

## 打包

```sh
pnpm build:stable     # 产出 artifacts/ 下的 win-x64 安装包
```

macOS 构建必须在 macOS 上进行（ElectroBun 面向当前机器系统构建）。

## 已知限制

- 关闭主窗口后应用驻留托盘；如系统托盘创建失败，关闭窗口会直接退出。
- macOS 用 WKWebView（Safari 内核），尚未在此环境验证 dsh 前端行为。
- 应用自身更新（ElectroBun `Updater` / bsdiff 增量）尚未接入；后端版本通过重新打包跟进。
