#!/usr/bin/env node
// npm postinstall: download the matching platform standalone binary from the
// GitHub Release for this package version, verify its SHA-256, and install it
// atomically under <pkg>/larkin-bin/<platform>-<arch>/. The npm tarball itself
// never ships the binary; this runs only for registry/git installs (never in the
// source repo, which ships src/ and scripts/build.mjs).
//
// Failures are non-fatal on purpose: `bin` (scripts/npm/larkin-bin-shim.mjs)
// falls back to the Bun-compiled JS entry when the binary is unavailable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

function warn(message) {
  process.stderr.write(`[larkin install] ${message}\n`);
}

function inSourceRepo() {
  return fs.existsSync(path.join(PKG_ROOT, "src")) && fs.existsSync(path.join(PKG_ROOT, "scripts", "build.mjs"));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function expectedSha256(checksumsText, filename) {
  for (const line of String(checksumsText).split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === filename && /^[a-f0-9]{64}$/.test(sha)) return sha;
  }
  return null;
}

async function main() {
  if (process.env.LARKIN_NPM_BINARY_DISABLE === "1") return;
  if (inSourceRepo()) return;

  // 延迟导入编译产物：源码仓库/CI 中 `dist/` 可能尚未构建，静态 import 会在
  // 守卫之前失败（bun install 会运行根包 postinstall）。
  const { RELEASE_TARGETS, artifactFilename, normalizeReleasePlatform, sha256File } = await import(
    "../../dist/platform/release-artifacts.mjs"
  );

  const platform = normalizeReleasePlatform(os.platform());
  const arch = os.arch();
  const target = RELEASE_TARGETS.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!target) return; // no standalone binary for this platform → JS fallback

  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch (error) {
    warn(`无法读取包版本：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let filename;
  try {
    filename = artifactFilename(version, target.platform, target.arch);
  } catch (error) {
    warn(`跳过下载：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const baseUrl = String(process.env.LARKIN_RELEASE_BASE_URL || `https://github.com/eddiearc/larkin/releases/download/v${version}`).replace(/\/+$/, "");
  const destinationDir = path.join(PKG_ROOT, "larkin-bin", `${target.platform}-${target.arch}`);
  const destination = path.join(destinationDir, target.platform === "windows" ? "larkin.exe" : "larkin");

  let expected;
  try {
    const checksums = await fetchWithTimeout(`${baseUrl}/SHA256SUMS`, 30_000);
    expected = expectedSha256(checksums.toString("utf8"), filename);
  } catch (error) {
    if (fs.existsSync(destination)) {
      warn(`SHA256SUMS 下载失败，保留已安装二进制：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    warn(`SHA256SUMS 下载失败，将回退到 Bun JS 入口：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!expected) {
    warn(`SHA256SUMS 中缺少 ${filename} 的校验和，将回退到 Bun JS 入口`);
    return;
  }

  if (fs.existsSync(destination) && sha256File(destination) === expected) return; // already current

  let bytes;
  try {
    bytes = await fetchWithTimeout(`${baseUrl}/${filename}`, 5 * 60_000);
  } catch (error) {
    warn(`二进制下载失败，将回退到 Bun JS 入口：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  const temporary = path.join(destinationDir, `.larkin.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes);
    if (sha256File(temporary) !== expected) throw new Error("checksum mismatch");
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, destination);
    process.stderr.write(`[larkin install] installed ${filename}\n`);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    warn(`安装二进制失败，将回退到 Bun JS 入口：${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error) => {
  warn(`安装二进制异常，将回退到 Bun JS 入口：${error instanceof Error ? error.message : String(error)}`);
});
