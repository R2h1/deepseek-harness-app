# 手机访问（Mobile Access）设计方案

> 目标：给 DSH Desktop 桌面壳增加"手机访问"能力——手机扫码即可实时访问电脑上运行的
> DeepSeek Harness（局域网 + 可选公网）。参考第三方插件 DSH Pocket（by shaobeichen）的
> 思路，但**不依赖该插件**，把方案原生做进桌面壳。
>
> 状态：**设计评审稿**（未实现）
> 适用范围：Windows 优先（后续可扩展 macOS/Linux）

---

## 1. 背景与目标

### 1.1 问题

用户把 Harness 跑在电脑上，人一旦离开电脑（床/地铁/出差）就"失控"：
- 无法查看长任务的进度
- 无法给 agent 发新指令、点审批
- 没有远程桌面 / SSH，干等

### 1.2 目标

- **手机扫码即开**：局域网内（同一 WiFi）手机扫二维码 → 实时看到并操作电脑上的 Harness 界面
- **实时同步**：界面、流式输出、事件推送与电脑完全一致
- **可选公网**：人在外面也能访问（cloudflared 隧道）
- **零门槛**：无账号、无服务器、无环境变量、无内网穿透配置
- **安全**：URL=钥匙；公网可选 PIN 保护；二维码每次重启轮换

### 1.3 非目标

- 不做多用户/账号体系
- 不做跨设备状态同步（只做实时访问）
- 不修改 deepseek-harness 引擎本身

---

## 2. 现状与关键约束（已查证）

### 2.1 引擎绑定与信任栅栏

| 事实 | 来源 |
|---|---|
| `dsh web --host 0.0.0.0` **被官方硬性禁止**（"would expose remote code execution to the network"） | `apps/cli/src/bin.ts`、`packages/bundle/web-app/src/startup.ts` |
| `/api` 浏览器信任栅栏只接受 loopback 或 `--trusted-host` 白名单 | `packages/client/connection/src/rpc-host.ts`、`api-request-trust` |
| dsh 默认只监听 `127.0.0.1` | `packages/host/webserver` |
| `--trusted-host` 只作用于信任栅栏，**不改变监听地址** | `startup.ts` |

**结论**：不能通过改 dsh 配置直接暴露到网络。**必须用反向代理**：壳内跑一个监听
`0.0.0.0:<port>` 的代理，把入站 Host/Origin 改写成 `127.0.0.1:<dshPort>` 再转发——
栅栏永远看到 loopback，LAN/公网都能进，且不改 dsh 任何配置。

### 2.2 桌面壳现状（有利条件）

- 壳是 ElectroBun（Bun 主进程），完全可控，`src/bun/index.ts` 负责所有生命周期
- 引擎以 `dsh web --port 0` 启动，端口动态，壳已能拿到真实 URL
- Bun 自带 HTTP/WebSocket 服务器（`Bun.serve`），无需额外运行时
- 壳已有"加载页"模式（`loaderUrl()` 返回 data: HTML），可作为手机访问 UI 的宿主

### 2.3 参考实现（DSH Pocket，仅参考思路）

其核心机制：
1. **反向代理**：监听 `0.0.0.0:3081`，改写 Host/Origin → `127.0.0.1:<dshPort>`，HTTP+WS 全透传
2. **HTML 注入**：非安全上下文（`http://<LAN-IP>`）里没有 `crypto.randomUUID` → 注入 polyfill；
   给桌面版 profile 注入 `dsh-desktop-mode=compatibility` 补丁（否则桌面版客户端白屏）
3. **cloudflared 快速隧道**：公网 https URL，每次重启换新；国内镜像 + 多线程下载
4. **二维码**：LAN/公网各一个，本地生成
5. **安全**：URL=钥匙；公网可选 8 位 PIN + HttpOnly cookie 登录

我们复用这套**思路**，但实现全部自研、放进桌面壳（不依赖 cordis 插件，引擎升级不丢功能）。

---

## 3. 总体架构

```
┌─────────────────────────── DSH Desktop (ElectroBun, Bun 主进程) ───────────────────────────┐
│                                                                                             │
│  手机 / 浏览器(外网)                    手机 / 浏览器(局域网)           桌面 WebView(GUI)       │
│        │                                    │                              │                │
│        ▼                                    ▼                              ▼                │
│  ┌────────────┐                       ┌───────────────────┐        ┌────────────────┐        │
│  │ cloudflared │── https://xxx.trycloudflare.com ──┐      │        │                │        │
│  │ 隧道(可选)  │──────────────┐                    │      │        │                │        │
│  └────────────┘              ▼                    ▼      │        │                │        │
│                     ┌────────────────────────────────┐   │        │                │        │
│                     │  Mobile Proxy  (Bun.serve)      │   │        │                │        │
│                     │  监听 0.0.0.0:<proxyPort>       │   │        │                │        │
│                     │  · Host/Origin → 127.0.0.1:dsh  │   │        │                │        │
│                     │  · HTML 注入(polyfill/兼容补丁) │   │        │                │        │
│                     │  · /api + WS 透传               │   │        │                │        │
│                     │  · 公网 PIN 登录(可选)          │   │        │                │        │
│                     └──────────────┬─────────────────┘   │        │                │        │
│                                    │ 127.0.0.1:<dshPort> │        │                │        │
│                                    ▼                    │        │                │        │
│                    ┌──────────────────────────────┐     │        │                │        │
│                    │  dsh web (引擎, 未改动)       │◄────┘        │                │        │
│                    └──────────────────────────────┘              │                │        │
│                                                                  │                │        │
│  ┌────────────────────────────────────────────┐                  │                │        │
│  │ Mobile Access UI (壳内小窗口)               │◄─ status RPC ────┘                │        │
│  │  · LAN 二维码 / 公网开关 / 状态             │  (127.0.0.1:<statusPort>)         │        │
│  └────────────────────────────────────────────┘                                      │        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**要点**：
- 所有代理/隧道逻辑都在**壳主进程**（Bun），引擎零改动
- 手机访问 UI 是壳自己的小窗口（不是引擎 GUI），通过本地 status RPC 与壳交互
- 桌面 WebView(GUI) 走原有直连路径，**不受代理影响**

---

## 4. 组件设计

### 4.1 LAN IP 智能选择（`selectLanIPv4`）

从 `os.networkInterfaces()` 选手机最可能可达的 IPv4：
- 排除 loopback（127.*）与 link-local（169.254.*）
- 打分：RFC1918 私网（10/8、172.16/12、192.168/16）+100；物理网卡名
  （wlan/wi-fi/wireless/ethernet/eth/en/wlp/以太网/本地连接）+20；VPN/虚拟网卡名
  （radmin/tailscale/zerotier/tun/tap/vpn/vethernet/virtual/vmware/virtualbox/wsl/docker/teredo/
  hamachi/bluetooth/bridge）−50
- 同分保持枚举顺序；无私网地址时回退最高分

> 避免踩 DSH Pocket 踩过的坑：Windows 上 Radmin/Tailscale/vEthernet 常排在 WLAN 前面，
> 直接取第一张非回环网卡会生成手机打不开的二维码。

### 4.2 反向代理（`createMobileProxy`）

用 `Bun.serve`（`hostname: "0.0.0.0"`，端口从 3081 起、被占用自动 +1，最多试 10 个）：

**普通 HTTP 请求**：
1. 入站请求头里的 `Host`/`Origin` 改写成 `127.0.0.1:<dshPort>`（loopback 权威）
2. 用改写后的头把请求转发到 `http://127.0.0.1:<dshPort><path>`（保留 method/query/body）
3. 回包：
   - `Content-Type: text/html` 且**未压缩** → 读取全文，向 `<head>` 注入脚本，
     修正 `Content-Length`，再回写
   - 其余（JSON/SSE/JS/CSS/二进制）→ 状态码 + 头 + 流式体原样透传
4. 上游不可达 → 502 中文提示

**WebSocket 升级（/api/events.mux 等流式通道）**：
- `server.upgrade(req)` 接管入站 WS；在 `open` 里向 `ws://127.0.0.1:<dshPort><path>`
  建立上游 WS，双向透传消息（text/binary 原样）；任一端关闭即清理另一端

**HTML 注入内容**（标记 `data-dsh-mobile-inject` 判重）：
1. `crypto.randomUUID` polyfill（非安全上下文必需，用 `getRandomValues` 实现 v4）
2. 桌面兼容补丁：`history.replaceState` 补 `dsh-desktop-mode=compatibility` 与
   `dsh-desktop-platform=<platform>`（引擎 profile 里若含桌面客户端，缺参会白屏）

> 设计权衡：Bun.serve 的 WS 桥接比 Node 原生 TCP 管道多一跳。DSH 的 mux 协议是消息帧，
> 消息级桥接应可容忍；实现后需用真实会话验证（见 §8）。若发现问题，降级方案是
> `Bun.connect` 做原始 TCP 透传。

### 4.3 二维码与手机访问 UI（`mobile-ui.ts` + 壳内小窗口）

**方案**：UI 是壳加载的一个独立小窗口（data: HTML，复用加载页模式），**二维码在页面内
用内嵌的纯 JS QR 库生成**（客户端生成，无服务端依赖、离线可用）。

- 页面通过 `fetch("http://127.0.0.1:<statusPort>/status")` 拉 JSON，每 2s 轮询
- 渲染：
  - **局域网**：`http://<LAN-IP>:<proxyPort>` + 二维码 + 复制按钮
  - **公网**（Phase 2）：开关按钮 + `https://<random>.trycloudflare.com` + 二维码 + 状态
  - 安全提示（"二维码即钥匙，勿转发"）
- 操作按钮调 status 端点 POST（`/tunnel/start`、`/tunnel/stop`）

**status 端点**：壳另起一个只监听 `127.0.0.1` 的小 HTTP 服务（或复用一个固定的内部端口，
如 `statusPort = proxyPort + 1000`；为避免与业务冲突，优先用一个高位固定端口，冲突则偏移）。
返回 JSON：
```jsonc
{
  "lanUrl": "http://192.168.1.5:3081",
  "proxyRunning": true,
  "tunnel": { "running": false, "url": null, "phase": "idle", "detail": "" },
  "pinEnabled": false
}
```

### 4.4 公网隧道（Phase 2，`tunnel.ts`）

cloudflared 快速隧道：
1. **下载**：优先 PATH 已有；否则持久缓存 `%LOCALAPPDATA%\dsh-desktop\cloudflared\`
   （或 `~/.dsh` 下），缓存缺失才下载。源顺序：GitHub 官方 → ghproxy.net → gh.ddlc.top →
   gh-proxy.com；Windows 官方源慢（~200KB/s）时用 Range 多线程分块（8 段）拉到 ~1.6MB/s
2. **启动**：`cloudflared tunnel --url http://127.0.0.1:<proxyPort> --protocol http2
   --no-autoupdate`，从 stdout 正则提取 `https://<random>.trycloudflare.com`
3. **状态机**：`idle → downloading → starting → registering → ready | error`
4. **生命周期**：`kill()` 停止；进程异常退出 → 状态打回 error；重启后按持久化标记
   （`tunnel-auto.json`）自动恢复（引擎重启会杀掉 cloudflared 子进程）
5. **URL 轮换**：每次启动新 URL，旧链接立即失效

### 4.5 安全设计

| 场景 | 措施 |
|---|---|
| 局域网 | URL=钥匙；仅同网段可达；UI 明确提示"勿转发二维码/URL" |
| 公网（Phase 2） | **8 位数字 PIN 登录**：隧道 Host（`*.trycloudflare.com`）强制要求，
  登录页 + HttpOnly 会话 cookie（浏览器关闭失效）；PIN 每次开隧道时新生成并在 UI 一次性显示 |
| 引擎风险 | dsh web 可执行代码 → 文档与 UI 双重警告：**不要把二维码/URL 发给任何人** |
| 网络暴露面 | 代理只在开启时监听 `0.0.0.0`；退出/关闭功能即停止代理 |
| Windows 防火墙 | 首次监听 `0.0.0.0` 可能触发防火墙提示，文档说明放行 |

---

## 5. 接口定义

### 5.1 status RPC（127.0.0.1）

```
GET  /status          → 完整状态 JSON（见 4.3）
POST /tunnel/start    → 启动公网隧道（Phase 2）
POST /tunnel/stop     → 停止公网隧道（Phase 2）
```

### 5.2 壳内部接口（`mobile-access.ts` 导出）

```ts
interface MobileAccessService {
  startProxy(dshPort: number): Promise<{ port: number }>   // 幂等；EADDRINUSE 自动 +1
  stopProxy(): Promise<void>
  status(): MobileStatus                                  // 供 status RPC 使用
  // Phase 2:
  startTunnel(): Promise<string>                          // 返回公网 URL
  stopTunnel(): void
  dispose(): Promise<void>                                // 退出时全关
}
```

### 5.3 托盘集成（`index.ts`）

- 托盘新增菜单项「手机访问」→ 打开手机访问小窗口（复用 `ensureWindow` 或独立窗口）
- 引擎就绪（拿到 dsh URL）后自动 `startProxy(dshPort)`

---

## 6. 文件结构（新增）

```
src/bun/mobile-access.ts   — LAN IP 选择 / 反向代理 / status 服务 / 服务编排
src/bun/mobile-ui.ts       — 手机访问 UI（data: HTML，内嵌 QR 生成，轮询 status RPC）
src/bun/tunnel.ts          — cloudflared 下载/启动/状态机/自动恢复（Phase 2）
src/bun/index.ts           — 接线：引擎就绪→startProxy；托盘项→打开 UI 窗口；退出→dispose
docs/mobile-access.md      — 本文档
```

> 不新增 npm 运行时依赖：代理/WS/HTTP 用 Bun 内置；QR 在页面内用内嵌 JS 库生成；
> cloudflared 按需下载（Phase 2）。

---

## 7. 分阶段计划

### Phase 1 — 局域网访问（核心价值，先做）
- [ ] `selectLanIPv4` + 单测
- [ ] `createMobileProxy`（Host/Origin 改写 + HTML 注入 + HTTP/WS 透传）
- [ ] 手机访问 UI（LAN 二维码 + 复制 + 提示）
- [ ] 托盘「手机访问」项 + 引擎就绪自动 startProxy
- [ ] 验证：真实手机扫码 → 打开界面 → 发消息 → 流式输出实时

### Phase 2 — 公网访问
- [ ] cloudflared 下载（镜像 + 多线程）+ 隧道启动/停止/状态机
- [ ] 公网二维码 + 开关 UI
- [ ] 8 位 PIN 登录（代理层 gate）
- [ ] 重启自动恢复隧道
- [ ] 验证：4G 网络扫码访问 + PIN 登录

---

## 8. 测试方案

| 项 | 方法 |
|---|---|
| LAN IP 选择 | 单测：喂假 `networkInterfaces()`（WLAN 排后、VPN 干扰）断言选对 |
| Host/Origin 改写 | 本机 `curl -H "Host: 192.168.x.x:3081" http://127.0.0.1:3081/` → 看 dsh 日志收到的权威是 loopback；`/api` 请求不被栅栏拒绝 |
| HTML 注入 | curl 首页 → 断言含 `data-dsh-mobile-inject` 且 `Content-Length` 正确 |
| WS 透传 | 打开会话 → 流式输出在手机端实时滚动（mux 协议经桥接正常） |
| 信任栅栏 | 伪造 Origin 的非同源请求被拒；同网段直连可正常操作 |
| 二维码 | 手机扫码 → 打开正确 URL |
| 防火墙 | 首次监听 0.0.0.0 的放行提示与文档一致 |
| 隧道(P2) | 启动 → 拿 URL → 手机 4G 访问 → PIN 登录 → 操作；重启后自动恢复 |

---

## 9. 风险与限制

1. **WS 桥接多一跳**：Bun.serve 桥接 vs Node 原生管道。若 mux 协议对时序敏感，需降级为
   `Bun.connect` 原始 TCP 透传（实现成本略高）
2. **桌面 profile 兼容性**：手机浏览器访问依赖 `dsh-desktop-mode=compatibility` 注入；
   若引擎桌面 client 升级改变行为需跟进
3. **非安全上下文**：`http://<LAN-IP>` 缺 `crypto.randomUUID` 等，靠 polyfill；公网 https
   原生可用，但桌面兼容补丁仍需要
4. **安全暴露面**：监听 0.0.0.0 即把"能执行代码"的引擎暴露给同网段；靠 URL 即钥匙 +
   （公网）PIN + 强文档提示控制；关闭功能即停止监听
5. **cloudflared 依赖**（P2）：下载源、稳定性依赖 Cloudflare 服务；URL 每次轮换是特性也是
   限制（用户需每次扫码）
6. **动态端口**：proxyPort/statusPort 需与业务端口错开，冲突自动偏移

---

## 10. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 实现位置 | 桌面壳（Bun 主进程） | 引擎零改动；引擎升级不丢功能；壳完全可控 |
| 代理实现 | `Bun.serve`（HTTP+WS） | Bun 内置，无额外运行时 |
| 二维码 | 页面内嵌 JS 客户端生成 | 无服务端依赖，离线可用 |
| 公网 | cloudflared 快速隧道 | 零配置、URL 轮换即安全；复用社区验证过的路径 |
| 安全 | LAN 免密 + 公网 PIN | 门槛与安全的平衡，与社区惯例一致 |
