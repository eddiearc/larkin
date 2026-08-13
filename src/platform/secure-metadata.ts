import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Cross-platform secure-metadata helpers. POSIX platforms enforce ownership and
 * mode bits (fail-closed). Windows has no POSIX mode bits, so mode-bit assertions
 * are skipped there; ownership on Windows is enforced by the filesystem/ACL and the
 * parent-directory containment checks elsewhere. Windows runtime behavior is marked
 * unverified (Owner decision B: no Windows validation in this delivery).
 */

export const isWindows = process.platform === "win32";

interface ModeStat { mode: number }

/** POSIX: `mode & 0o777` must equal `expected`. Windows: always passes. */
export function exactMode(stat: ModeStat, expected: number): boolean {
  if (isWindows) return true;
  return (stat.mode & 0o777) === expected;
}

/** POSIX: group/other must have no access bits. Windows: always passes. */
export function notGroupOrWorldAccessible(stat: ModeStat): boolean {
  if (isWindows) return true;
  return (stat.mode & 0o077) === 0;
}

/** Fsync a directory after rename for durability. Windows cannot open a directory for fsync, so this is a no-op. */
export function fsyncDirectory(directory: string): void {
  if (isWindows) return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Fsync the parent directory of `file` after rename for durability. Windows: no-op. */
export function fsyncDirectoryOf(file: string): void {
  fsyncDirectory(path.dirname(file));
}

export interface SecureWindowsDirectoryAclOptions {
  spawn?: typeof spawnSync;
  label?: string;
  username?: string;
}

const SYSTEM_SID = "*S-1-5-18";
const ACE_LINE = /^\s*(.+?)\s*:(\((?:[A-Za-z]+)\))+\s*$/;

function allowedAclPrincipal(principal: string, username: string): boolean {
  const candidate = principal.trim().toLocaleLowerCase("en-US");
  const user = username.toLocaleLowerCase("en-US");
  if (!candidate) return false;
  if (candidate === user) return true;
  const suffix = candidate.split("\\").at(-1) ?? candidate;
  if (suffix === user) return true;
  if (candidate === "*s-1-5-18" || candidate === "system" || candidate === "nt authority\\system") return true;
  return false;
}

/**
 * 执行 Windows ACL 收紧序列（无平台守卫，供测试直接驱动与 win32 分支调用）：
 * 1) /inheritance:r 去除继承；2) 只授予当前用户 + SYSTEM 完全控制；
 * 3) 显式移除 Users/Authenticated Users/Everyone；4) 回读 ACL 校验，
 * 任何残留第三方 ACE 一律 fail-closed。icacls 为 Windows 内置工具。
 */
export function runWindowsDirectoryAcl(directory: string, options: SecureWindowsDirectoryAclOptions = {}): void {
  const label = options.label ?? directory;
  const username = String(options.username ?? os.userInfo().username ?? "").trim();
  if (!username) throw new Error(`Windows ACL 收紧失败（${label}）：无法取得当前用户名`);
  const run = (args: readonly string[]): string => {
    const result = (options.spawn ?? spawnSync)("icacls", [directory, ...args], {
      encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
    }) as SpawnSyncReturns<string>;
    if (result.error || result.status !== 0) {
      throw new Error(`Windows ACL 收紧失败（${label}）：icacls ${args[0] ?? "查询"} 退出 ${result.status ?? "无"}${result.error ? `（${result.error.message}）` : ""}`);
    }
    return String(result.stdout || "");
  };
  run(["/inheritance:r"]);
  run(["/grant:r", `${username}:(OI)(CI)F`, "/grant:r", `${SYSTEM_SID}:(OI)(CI)F`]);
  run(["/remove:g", "Users", "/remove:g", "Authenticated Users", "/remove:g", "Everyone"]);
  const listing = run([]);
  // icacls 首行是「<路径> <首条 ACE>」同行，其余 ACE 缩进另起一行；先剥掉已知目录前缀再解析。
  const pathPrefix = directory.toLocaleLowerCase("en-US");
  const offenders = listing.split(/\r?\n/).map((line) => {
    let body = line.trimStart();
    if (body.toLocaleLowerCase("en-US").startsWith(`${pathPrefix} `)) body = body.slice(directory.length + 1).trimStart();
    return body;
  }).filter((line) => ACE_LINE.test(line))
    .map((line) => (line.match(ACE_LINE) ?? ["", ""])[1])
    .filter((principal) => !allowedAclPrincipal(principal, username));
  if (offenders.length > 0) {
    throw new Error(`Windows ACL 校验失败（${label}）：存在未授权访问者 ${offenders.join(", ")}`);
  }
}

/**
 * Windows 没有 POSIX 权限位（mode 恒为 0o666、getuid 为 undefined）：
 * 用 runWindowsDirectoryAcl 收紧目录 ACL 并回读校验。非 win32 平台 no-op。
 */
export function secureWindowsDirectoryAcl(directory: string, options: SecureWindowsDirectoryAclOptions = {}): void {
  if (!isWindows) return;
  runWindowsDirectoryAcl(directory, options);
}
