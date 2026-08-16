import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "DeepSeek Harness",
    identifier: "ai.deepseek.dsh-desktop",
    version: "0.1.0",
  },
  runtime: {
    // The tray owns the app lifecycle: closing the window keeps the app (and
    // the backend) running; quit happens from the tray menu.
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      // Self-contained backend, provisioned from the latest @deepseek-ai/dsh
      // (run `pnpm backend:provision` before packaging). Lands in
      // <app>/Resources/app/backend.
      "resources/backend": "backend",
      // A bundled Node runtime for the backend. Lands in <app>/Resources/app/node.
      "resources/node": "node",
      // A bundled pnpm CLI so the app can install the latest backend at runtime.
      "resources/pnpm": "pnpm",
      // Tray icon (PNG for macOS, ICO for Windows) and app icon (Windows).
      "resources/icons/tray.png": "tray.png",
      "resources/icons/tray.ico": "tray.ico",
      // The backend trim script, so runtime-installed backends get pruned too.
      "scripts/trim-node-modules.mjs": "trim-node-modules.mjs",
    },
    win: {
      icon: "resources/icons/app.ico",
    },
  },
} satisfies ElectrobunConfig;
