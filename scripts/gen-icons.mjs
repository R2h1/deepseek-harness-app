#!/usr/bin/env node
/**
 * Generate the app icons from the DeepSeek whale SVGs:
 *  - resources/icons/tray.png  — blue whale on transparent (system tray)
 *  - resources/icons/app.ico   — whale on the DeepSeek blue tile, multi-size
 *                                PNG-compressed ICO (Windows installer/shortcut)
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "resources", "icons");
mkdirSync(iconsDir, { recursive: true });

const traySvg = readFileSync(join(iconsDir, "tray.svg"), "utf8");
const appSvg = readFileSync(join(iconsDir, "app-icon.svg"), "utf8");

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return Buffer.from(resvg.render().asPng());
}

// Tray icon — 32px blue whale on transparent.
writeFileSync(join(iconsDir, "tray.png"), renderPng(traySvg, 32));
console.log("wrote resources/icons/tray.png (32x32)");

// App icon — PNG-compressed ICO with the standard size ladder.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => renderPng(appSvg, size));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4); // count

const entries = [];
let offset = 6 + 16 * images.length;
images.forEach((png, index) => {
  const size = sizes[index];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
  entry.writeUInt8(0, 2); // color count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png.length, 8); // bytes in resource
  entry.writeUInt32LE(offset, 12); // image offset
  offset += png.length;
  entries.push(entry);
});

writeFileSync(join(iconsDir, "app.ico"), Buffer.concat([header, ...entries, ...images]));
console.log(`wrote resources/icons/app.ico (${sizes.join("/")})`);
