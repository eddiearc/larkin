import fs from "node:fs";
import path from "node:path";

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
