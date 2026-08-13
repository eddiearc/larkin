#!/usr/bin/env node
// npm `bin` entry. Prefers the postinstall-downloaded standalone binary; falls
// back to the Bun-compiled JS entry when the binary is absent (unsupported
// platform or a failed/interrupted install) and Bun is on PATH.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RELEASE_TARGETS, normalizeReleasePlatform } from "../../dist/platform/release-artifacts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

const platform = normalizeReleasePlatform(os.platform());
const target = RELEASE_TARGETS.find((candidate) => candidate.platform === platform && candidate.arch === os.arch());
const binary = target
  ? path.join(PKG_ROOT, "larkin-bin", `${target.platform}-${target.arch}`, target.platform === "windows" ? "larkin.exe" : "larkin")
  : null;
const argv = process.argv.slice(2);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) return null;
  return result.status ?? 0;
}

if (binary && fs.existsSync(binary)) {
  const status = run(binary, argv);
  if (status !== null) process.exit(status);
  process.stderr.write(`[larkin] 平台二进制启动失败，尝试 Bun fallback…\n`);
}

const bunEntry = path.join(PKG_ROOT, "dist", "app", "cli.mjs");
if (fs.existsSync(bunEntry)) {
  const bun = process.env.LARKIN_BUN || "bun";
  const status = run(bun, [bunEntry, ...argv]);
  if (status !== null) process.exit(status);
}

process.stderr.write(
  "[larkin] 未找到可用的平台二进制，也未找到 Bun。\n" +
  "  - 联网重新安装会自动下载对应平台二进制：npm install -g larkin\n" +
  "  - 或安装 Bun 1.3.14 后重试（会走 JS 入口 fallback）\n" +
  "  - 或从 GitHub Release 下载 standalone 二进制：https://github.com/eddiearc/larkin/releases\n",
);
process.exit(1);
