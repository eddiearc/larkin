import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import processInspect from "../platform/process-inspect.cjs";
import { applyPiPackageDirForChild } from "./builtin-pi-assets.js";
import { resolveRuntimeExecutable } from "./runtime-readiness.js";
import { mergeOwnedPiSettings, parsePiExecutableVersion } from "./pi-compaction-recovery.js";
import { BUNDLED_PI_VERSION } from "./pi-provider-config.js";
import { attestedPiRuntimeArtifactNames, PI_RUNTIME_ARTIFACT_MANIFEST } from "./pi-artifact-provenance.js";

const AGENT_ID = /^cli_[A-Za-z0-9]+$/;
const FILES = ["auth.json", "models.json", "settings.json"] as const;
const BUILTIN_PI_PACKAGE = /^npm:@tintinweb\/pi-subagents(?:@[^/]+)?$|^@tintinweb\/pi-subagents(?:@[^/]+)?$/i;
const FILE_LIMIT = 8 * 1024 * 1024;
const EXECUTABLE_LIMIT = 256 * 1024 * 1024;
const SOURCE_MODES = new Set([0o600, 0o644, 0o640]);

type FileName = typeof FILES[number];
interface FileState { present: boolean; sha256?: string; bytes?: number; mode?: number; content?: string }
interface ExecutableState { path: string; sha256: string; bytes: number; mode: number }
export interface PiProfileMigrationState {
  version: 1;
  agentId: string;
  sourceDir: string;
  sourceDirMode: number;
  sourceCommand: string;
  sourceExecutable: ExecutableState;
  sourceFiles: Record<FileName, FileState>;
  targetDir: string;
  targetDirExisted: boolean;
  targetDirMode: number;
  targetDirDevice?: number;
  targetDirInode?: number;
  targetEntries: string[];
  priorFiles: Record<FileName, FileState>;
  afterFiles: Record<FileName, FileState>;
}

export interface PiProfileMigrationPlan {
  state: PiProfileMigrationState;
  sourceBytes: Record<FileName, Buffer>;
  sourceEnvironment: { PATH?: string; LARKIN_PI_COMMAND?: string; PI_PACKAGE_DIR?: string };
}

const TARGET_LOCK_SUFFIX = ".larkin-pi-import.lock";
function hash(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function targetLockFile(state: PiProfileMigrationState): string { return path.join(path.dirname(state.targetDir), `${state.agentId}${TARGET_LOCK_SUFFIX}`); }
function acquireTargetLock(state: PiProfileMigrationState): void {
  const file = targetLockFile(state);
  assertNoSymlinkAncestors(path.dirname(file));
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`); fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Pi provider target is busy; refusing migration");
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  fsyncDirectory(path.dirname(file));
}
export function releasePiProfileMigrationLock(state: PiProfileMigrationState): void {
  try { fs.unlinkSync(targetLockFile(state)); fsyncDirectory(path.dirname(targetLockFile(state))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const TARGET_BUSY = "Pi provider target is busy";
export interface ClearStalePiProfileMigrationLockOptions {
  kill?: typeof process.kill;
}
function migrationLockPath(configDir: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error("Pi Agent ID 格式无效");
  return path.join(path.resolve(configDir), "providers", "pi", `${agentId}${TARGET_LOCK_SUFFIX}`);
}
function lockPidFromBytes(bytes: Buffer): number | null {
  const text = bytes.toString("utf8");
  if (text.endsWith("\n") ? text.slice(0, -1).includes("\n") : text.includes("\n")) return null;
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!/^[1-9][0-9]*$/.test(line)) return null;
  const pid = Number(line);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function inspectOwnedLock(file: string): { pid: number; dev: number; ino: number } | null {
  let fd: number | undefined;
  try {
    const initial = fs.lstatSync(file);
    if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o777) !== 0o600) {
      throw new Error(TARGET_BUSY);
    }
    assertOwner(initial, "Pi provider lock");
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw new Error(TARGET_BUSY);
    assertOwner(before, "Pi provider lock");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(fd, bytes, offset, before.size - offset, null);
      if (read === 0) throw new Error(TARGET_BUSY);
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== before.nlink
        || after.uid !== before.uid || (after.mode & 0o777) !== 0o600) throw new Error(TARGET_BUSY);
    const pid = lockPidFromBytes(bytes.subarray(0, after.size));
    if (pid === null) throw new Error(TARGET_BUSY);
    return { pid, dev: after.dev, ino: after.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(TARGET_BUSY);
    if (error instanceof Error && error.message === TARGET_BUSY) throw error;
    if (error instanceof Error && /unsafe/.test(error.message)) throw new Error(TARGET_BUSY);
    throw new Error(TARGET_BUSY);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Reclaim a credential-adjacent import lock only when it is a proven-dead owned regular file. */
export function clearStalePiProfileMigrationLock(
  configDir: string,
  agentId: string,
  options: ClearStalePiProfileMigrationLockOptions = {},
): void {
  const file = migrationLockPath(configDir, agentId);
  assertNoSymlinkAncestors(path.dirname(file));
  const inspected = inspectOwnedLock(file);
  if (!inspected) return;
  const kill = options.kill ?? process.kill;
  if (processInspect.pidAlive(inspected.pid, kill)) throw new Error(TARGET_BUSY);
  const quarantine = `${file}.stale-${process.pid}-${crypto.randomUUID()}`;
  try { fs.renameSync(file, quarantine); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(TARGET_BUSY);
  }
  fsyncDirectory(path.dirname(file));
  try {
    const quarantined = fs.lstatSync(quarantine);
    if (quarantined.isSymbolicLink() || !quarantined.isFile() || quarantined.nlink !== 1
        || (quarantined.mode & 0o777) !== 0o600 || quarantined.dev !== inspected.dev || quarantined.ino !== inspected.ino) {
      throw new Error(TARGET_BUSY);
    }
    assertOwner(quarantined, "Pi provider lock");
    const bytes = fs.readFileSync(quarantine);
    if (lockPidFromBytes(bytes) !== inspected.pid || processInspect.pidAlive(inspected.pid, kill)) {
      throw new Error(TARGET_BUSY);
    }
  } finally {
    try { fs.unlinkSync(quarantine); } catch { /* quarantine is not the live lock path */ }
    fsyncDirectory(path.dirname(file));
  }
}
function isKnownSystemSymlink(value: string): boolean {
  return value === "/tmp" || value === "/private/tmp" || value === "/var" || value === "/private/var"
    || value === "/var/folders" || /^\/var\/folders\/[^/]+$/.test(value)
    || value === "/private/var/folders" || /^\/private\/var\/folders\/[^/]+$/.test(value);
}
function assertNoSymlinkAncestors(value: string): void {
  const resolved = path.resolve(value); let current = path.parse(resolved).root;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink() && !isKnownSystemSymlink(current)) throw new Error("Pi profile path contains a symlink ancestor");
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("Pi profile path ancestor is not a directory");
  }
}
function assertOwner(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner is unsafe`);
}
function assertDirectory(directory: string, label: string, required = true): fs.Stats | null {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
    assertOwner(stat, label);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return null;
    throw error;
  }
}
function readBounded(file: string, label: string, limit: number, required = true): { bytes: Buffer; mode: number } | null {
  let fd: number | undefined;
  try {
    const initial = fs.lstatSync(file);
    if (initial.isSymbolicLink()) throw new Error(`${label} is unsafe`);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`${label} is unsafe`);
    assertOwner(before, label);
    if (before.size > limit) throw new Error(`${label} is too large`);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = fs.readSync(fd, bytes, offset, before.size - offset, null);
      if (read === 0) throw new Error(`${label} changed while reading`);
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== before.nlink
        || after.uid !== before.uid || after.gid !== before.gid || (after.mode & 0o777) !== (before.mode & 0o777)) throw new Error(`${label} changed while reading`);
    return { bytes, mode: after.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${label} is unsafe`);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readRegular(file: string, label: string, required = true): { bytes: Buffer; mode: number } | null {
  return readBounded(file, label, FILE_LIMIT, required);
}
function readExecutable(file: string, label: string): ExecutableState {
  let resolved: string;
  try { resolved = fs.realpathSync(file); } catch { throw new Error(`${label} is unavailable`); }
  const readable = readBounded(resolved, label, EXECUTABLE_LIMIT);
  if (!readable || (readable.mode & 0o022) !== 0 || (readable.mode & 0o111) === 0) throw new Error(`${label} is unsafe`);
  return { path: resolved, sha256: hash(readable.bytes), bytes: readable.bytes.length, mode: readable.mode };
}
function sourceDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  const expanded = configured.startsWith("~") ? path.join(home, configured.slice(1)) : configured;
  return path.resolve(expanded || path.join(home, ".pi", "agent"));
}
function verifySourceProfile(directory: string): void {
  assertNoSymlinkAncestors(directory);
  assertDirectory(directory, "external Pi profile");
}
function safeState(file: { bytes: Buffer; mode: number } | null, includeContent: boolean): FileState {
  if (!file) return { present: false };
  return { present: true, sha256: hash(file.bytes), bytes: file.bytes.length, mode: file.mode, ...(includeContent ? { content: file.bytes.toString("base64") } : {}) };
}
function targetDirectory(configDir: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error("Pi Agent ID 格式无效");
  return path.join(path.resolve(configDir), "providers", "pi", agentId);
}
function sourceVersion(env: NodeJS.ProcessEnv, cwd: string): ExecutableState {
  const command = String(env.LARKIN_PI_COMMAND || "pi");
  const executable = resolveRuntimeExecutable(command, env);
  if (!executable) throw new Error("外部 Pi 0.84.2 profile import requires an installed Pi executable");
  const executableState = readExecutable(executable, "external Pi executable");
  const result = spawnSync(executableState.path, ["--version"], {
    cwd,
    env: applyPiPackageDirForChild(env, { distribution: "external" }),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) throw new Error("external Pi version probe failed");
  try { parsePiExecutableVersion(String(result.stdout || result.stderr || "").trim()); }
  catch { throw new Error(`external Pi must be exactly ${BUNDLED_PI_VERSION}`); }
  const afterProbe = readExecutable(executableState.path, "external Pi executable");
  if (afterProbe.sha256 !== executableState.sha256 || afterProbe.bytes !== executableState.bytes || afterProbe.mode !== executableState.mode) {
    throw new Error("external Pi executable changed during version probe");
  }
  return executableState;
}
function mergeSettings(bytes: Buffer, distribution: "builtin" | "external"): Buffer {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("external Pi settings.json is invalid"); }
  const merged = mergeOwnedPiSettings(value);
  // Builtin Pi always loads Larkin's inline subagents factory. Remove only that
  // duplicate package during builtin-profile import; external Pi must retain the
  // user's package so its resolver can suppress inline injection.
  if (distribution === "builtin" && Array.isArray(merged.packages)) {
    merged.packages = merged.packages.filter((entry) => typeof entry !== "string" || !BUILTIN_PI_PACKAGE.test(entry));
  }
  return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`);
}
function targetPrior(directory: string): { stat: fs.Stats | null; entries: string[]; files: Record<FileName, FileState> } {
  const stat = assertDirectory(directory, "Pi provider target", false);
  if (stat && (stat.mode & 0o777) !== 0o700) throw new Error("Pi provider target must be 0700");
  const entries = stat ? fs.readdirSync(directory).sort() : [];
  const files = Object.fromEntries(FILES.map((name) => {
    const file = readRegular(path.join(directory, name), `Pi provider target ${name}`, false);
    if (file && file.mode !== 0o600) throw new Error("Pi provider target files must be 0600");
    return [name, safeState(file, true)];
  })) as Record<FileName, FileState>;
  return { stat, entries, files };
}

export function preparePiProfileMigration(env: NodeJS.ProcessEnv, configDir: string, agentId: string, distribution: "builtin" | "external" = "builtin"): PiProfileMigrationPlan {
  const sanitized = applyPiPackageDirForChild({ ...env }, { distribution: "external" });
  const sourceDir = sourceDirectory(sanitized);
  verifySourceProfile(sourceDir);
  const sourceDirectoryState = assertDirectory(sourceDir, "external Pi profile") as fs.Stats;
  const sourceExecutable = sourceVersion(sanitized, sourceDir);
  const sourceFiles = Object.fromEntries(FILES.map((name) => {
    const file = readRegular(path.join(sourceDir, name), `external Pi ${name}`, false);
    if (!file) throw new Error(`external Pi ${name} is required`);
    if (name === "auth.json" && file.mode !== 0o600) throw new Error("external Pi auth.json has an unsafe mode");
    if (name !== "auth.json" && !SOURCE_MODES.has(file.mode)) throw new Error(`external Pi ${name} has an unsafe mode`);
    return [name, file];
  })) as Record<FileName, { bytes: Buffer; mode: number }>;
  const targetDir = targetDirectory(configDir, agentId);
  assertNoSymlinkAncestors(targetDir);
  const target = targetPrior(targetDir);
  const imported: Record<FileName, Buffer> = {
    "auth.json": sourceFiles["auth.json"].bytes,
    "models.json": sourceFiles["models.json"].bytes,
    "settings.json": mergeSettings(sourceFiles["settings.json"].bytes, distribution),
  };
  const afterFiles = Object.fromEntries(FILES.map((name) => [name, safeState({ bytes: imported[name], mode: 0o600 }, false)])) as Record<FileName, FileState>;
  return {
    state: { version: 1, agentId, sourceDir, sourceDirMode: sourceDirectoryState.mode & 0o777,
      sourceCommand: String(sanitized.LARKIN_PI_COMMAND || "pi"), sourceExecutable,
      sourceFiles: Object.fromEntries(FILES.map((name) => [name, safeState(sourceFiles[name], false)])) as Record<FileName, FileState>,
      targetDir, targetDirExisted: Boolean(target.stat), targetDirMode: target.stat ? target.stat.mode & 0o777 : 0o700,
      ...(target.stat ? { targetDirDevice: target.stat.dev, targetDirInode: target.stat.ino } : {}), targetEntries: target.entries,
      priorFiles: target.files, afterFiles },
    sourceBytes: { "auth.json": sourceFiles["auth.json"].bytes, "models.json": sourceFiles["models.json"].bytes,
      "settings.json": imported["settings.json"] },
    sourceEnvironment: {
      PATH: sanitized.PATH,
      LARKIN_PI_COMMAND: sanitized.LARKIN_PI_COMMAND,
      ...(sanitized.PI_PACKAGE_DIR ? { PI_PACKAGE_DIR: sanitized.PI_PACKAGE_DIR } : {}),
    },
  };
}

export function validatePiProfileMigrationState(value: unknown): asserts value is PiProfileMigrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi profile migration state is invalid");
  const state = value as Partial<PiProfileMigrationState>;
  if (state.version !== 1 || typeof state.agentId !== "string" || !AGENT_ID.test(state.agentId)
      || typeof state.sourceDir !== "string" || !Number.isInteger(state.sourceDirMode)
      || typeof state.sourceCommand !== "string" || !state.sourceCommand.trim() || /[\r\n\0]/.test(state.sourceCommand)
      || !state.sourceExecutable || typeof state.sourceExecutable.path !== "string"
      || typeof state.sourceExecutable.sha256 !== "string" || !Number.isSafeInteger(state.sourceExecutable.bytes)
      || state.sourceExecutable.bytes < 0 || !Number.isInteger(state.sourceExecutable.mode)
      || typeof state.targetDir !== "string" || typeof state.targetDirExisted !== "boolean"
      || !Number.isInteger(state.targetDirMode) || (state.targetDirExisted && (!Number.isSafeInteger(state.targetDirDevice) || !Number.isSafeInteger(state.targetDirInode)))
      || !Array.isArray(state.targetEntries) || state.targetEntries.some((entry) => typeof entry !== "string" || !entry || entry === "." || entry === ".." || entry.includes("/"))
      || !state.sourceFiles || !state.priorFiles || !state.afterFiles) throw new Error("Pi profile migration state is invalid");
  const collections: Array<{ files: Record<string, unknown>; prior: boolean }> = [
    { files: state.sourceFiles as Record<string, unknown>, prior: false },
    { files: state.priorFiles as Record<string, unknown>, prior: true },
    { files: state.afterFiles as Record<string, unknown>, prior: false },
  ];
  for (const name of FILES) {
    for (const collection of collections) {
      const file = collection.files[name];
      if (!file || typeof file !== "object" || typeof (file as FileState).present !== "boolean") throw new Error("Pi profile migration state is invalid");
      const record = file as FileState;
      if (record.present && (typeof record.sha256 !== "string" || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0)) throw new Error("Pi profile migration state is invalid");
      if (collection.prior && record.present) {
        if (typeof record.content !== "string" || record.mode !== 0o600) throw new Error("Pi profile migration state is invalid");
        const bytes = Buffer.from(record.content, "base64");
        if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw new Error("Pi profile migration state is invalid");
      }
    }
  }
}

function assertSourceUnchanged(state: PiProfileMigrationState, resolutionEnvironment: NodeJS.ProcessEnv = process.env, verifyResolution = true): void {
  const directory = assertDirectory(state.sourceDir, "external Pi profile");
  if ((directory!.mode & 0o777) !== state.sourceDirMode) throw new Error("external Pi profile changed; refusing migration");
  verifySourceProfile(state.sourceDir);
  const probeEnvironment = { ...process.env, ...resolutionEnvironment };
  const resolved = verifyResolution ? resolveRuntimeExecutable(state.sourceCommand, probeEnvironment) : state.sourceExecutable.path;
  if (!resolved) throw new Error("external Pi executable changed; refusing migration");
  const executable = readExecutable(resolved, "external Pi executable");
  if (executable.path !== state.sourceExecutable.path || executable.sha256 !== state.sourceExecutable.sha256
      || executable.bytes !== state.sourceExecutable.bytes || executable.mode !== state.sourceExecutable.mode) {
    throw new Error("external Pi executable changed; refusing migration");
  }
  const result = spawnSync(executable.path, ["--version"], {
    cwd: state.sourceDir,
    env: applyPiPackageDirForChild(probeEnvironment, { distribution: "external" }),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) throw new Error("external Pi version probe failed");
  try { parsePiExecutableVersion(String(result.stdout || result.stderr || "").trim()); }
  catch { throw new Error(`external Pi must be exactly ${BUNDLED_PI_VERSION}`); }
  const afterProbe = readExecutable(executable.path, "external Pi executable");
  if (afterProbe.sha256 !== executable.sha256 || afterProbe.bytes !== executable.bytes || afterProbe.mode !== executable.mode) {
    throw new Error("external Pi executable changed during version probe");
  }
  for (const name of FILES) {
    const file = readRegular(path.join(state.sourceDir, name), `external Pi ${name}`);
    const expected = state.sourceFiles[name];
    if (!file || !expected.present || hash(file.bytes) !== expected.sha256 || file.bytes.length !== expected.bytes || file.mode !== expected.mode) {
      throw new Error("external Pi profile changed; refusing migration");
    }
  }
}
function atomicPrivateWrite(file: string, bytes: Buffer): void {
  const temp = `${file}.larkin-pi-import-${process.pid}-${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); fs.chmodSync(file, 0o600); } finally { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
}
function currentFileState(file: string): FileState { return safeState(readRegular(file, "Pi provider target file", false), false); }
export function assertPiProfileMigrationAfterState(state: PiProfileMigrationState): void {
  validatePiProfileMigrationState(state);
  const target = assertDirectory(state.targetDir, "Pi provider target");
  if ((target!.mode & 0o777) !== 0o700) throw new Error("Pi provider migration target is unsafe");
  if (state.targetDirExisted && (target!.dev !== state.targetDirDevice || target!.ino !== state.targetDirInode)) throw new Error("Pi provider migration target changed");
  const expectedEntries = [...new Set([...state.targetEntries, ...FILES])].sort();
  if (JSON.stringify(fs.readdirSync(state.targetDir).sort()) !== JSON.stringify(expectedEntries)) throw new Error("Pi provider migration target entries changed");
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const expected = state.afterFiles[name];
    if (!current.present || !expected.present || current.sha256 !== expected.sha256 || current.bytes !== expected.bytes || current.mode !== 0o600) {
      throw new Error("Pi provider migration target is incomplete");
    }
  }
}
function assertTargetUnchanged(state: PiProfileMigrationState): void {
  const target = assertDirectory(state.targetDir, "Pi provider target", false);
  if (Boolean(target) !== state.targetDirExisted) throw new Error("Pi provider target changed; refusing migration");
  if (target && ((target.mode & 0o777) !== state.targetDirMode)) throw new Error("Pi provider target changed; refusing migration");
  if (target && state.targetDirExisted && (target.dev !== state.targetDirDevice || target.ino !== state.targetDirInode)) throw new Error("Pi provider target changed; refusing migration");
  if (target && JSON.stringify(fs.readdirSync(state.targetDir).sort()) !== JSON.stringify(state.targetEntries)) throw new Error("Pi provider target entries changed; refusing migration");
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    if (current.present !== prior.present || (current.present && (current.sha256 !== prior.sha256 || current.bytes !== prior.bytes || current.mode !== prior.mode))) {
      throw new Error("Pi provider target changed; refusing migration");
    }
  }
}
function assertPrior(state: PiProfileMigrationState): void {
  const target = assertDirectory(state.targetDir, "Pi provider target");
  if ((target!.mode & 0o777) !== state.targetDirMode) throw new Error("Pi provider target rollback directory changed");
  if (state.targetDirExisted && (target!.dev !== state.targetDirDevice || target!.ino !== state.targetDirInode)) throw new Error("Pi provider target rollback directory changed");
  if (JSON.stringify(fs.readdirSync(state.targetDir).sort()) !== JSON.stringify(state.targetEntries)) throw new Error("Pi provider target rollback entries changed");
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    if (current.present !== prior.present || (current.present && (current.sha256 !== prior.sha256 || current.bytes !== prior.bytes || current.mode !== prior.mode))) throw new Error("Pi provider target rollback is incomplete or conflicted");
  }
}
function restoreFile(file: string, prior: FileState): void {
  if (!prior.present) { try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return; }
  if (typeof prior.content !== "string") throw new Error("Pi provider rollback bytes are missing");
  atomicPrivateWrite(file, Buffer.from(prior.content, "base64"));
  if (prior.mode !== undefined) fs.chmodSync(file, prior.mode);
}

export function applyPiProfileMigration(plan: PiProfileMigrationPlan): void {
  const replayEnv = { ...process.env, ...plan.sourceEnvironment };
  if (plan.sourceEnvironment.PI_PACKAGE_DIR) replayEnv.PI_PACKAGE_DIR = plan.sourceEnvironment.PI_PACKAGE_DIR;
  else delete replayEnv.PI_PACKAGE_DIR;
  assertSourceUnchanged(plan.state, replayEnv);
  const parent = path.dirname(plan.state.targetDir); assertNoSymlinkAncestors(parent); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700);
  acquireTargetLock(plan.state);
  assertTargetUnchanged(plan.state);
  const existing = assertDirectory(plan.state.targetDir, "Pi provider target", false);
  if (existing && (existing.mode & 0o777) !== 0o700) throw new Error("Pi provider target must be 0700");
  if (!existing) {
    try { fs.mkdirSync(plan.state.targetDir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Pi provider target changed; refusing migration"); throw error; }
    fs.chmodSync(plan.state.targetDir, 0o700);
  }
  for (const name of FILES) {
    const current = currentFileState(path.join(plan.state.targetDir, name));
    const prior = plan.state.priorFiles[name];
    if (current.present !== prior.present || (current.present && (current.sha256 !== prior.sha256 || current.bytes !== prior.bytes || current.mode !== prior.mode))) {
      throw new Error("Pi provider target changed; refusing migration");
    }
    atomicPrivateWrite(path.join(plan.state.targetDir, name), plan.sourceBytes[name]);
  }
  assertPiProfileMigrationAfterState(plan.state);
  fsyncDirectory(plan.state.targetDir);
}
function fsyncDirectory(directory: string): void {
  try { const fd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort on platforms without directory fsync */ }
}

export function rollbackPiProfileMigration(state: PiProfileMigrationState): void {
  validatePiProfileMigrationState(state); assertSourceUnchanged(state, process.env, false);
  const target = assertDirectory(state.targetDir, "Pi provider target", false);
  if (!target) {
    if (state.targetDirExisted) throw new Error("Pi provider target disappeared during rollback");
    releasePiProfileMigrationLock(state);
    return;
  }
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    const expected = state.afterFiles[name];
    const isPrior = current.present === prior.present && (!current.present || (current.sha256 === prior.sha256 && current.bytes === prior.bytes && current.mode === prior.mode));
    const isExpected = current.present && current.sha256 === expected.sha256 && current.bytes === expected.bytes && current.mode === 0o600;
    if (!isPrior && !isExpected) throw new Error("Pi provider target changed; refusing migration rollback");
  }
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    const isPrior = current.present === prior.present && (!current.present || (current.sha256 === prior.sha256 && current.bytes === prior.bytes && current.mode === prior.mode));
    if (!isPrior) restoreFile(path.join(state.targetDir, name), prior);
  }
  if (!state.targetDirExisted) {
    const entries = fs.readdirSync(state.targetDir).filter((name) => !FILES.includes(name as FileName) && !name.startsWith(".larkin-pi-import-"));
    const attested = attestedPiRuntimeArtifactNames(state.targetDir);
    const removable = entries.filter((name) => attested.has(name) || name === PI_RUNTIME_ARTIFACT_MANIFEST);
    const unknown = entries.filter((name) => !removable.includes(name));
    // An allowed name is not provenance. Recursive cleanup is permitted only when
    // every surviving artifact is identity-attested by the runtime-owned manifest.
    if (unknown.length === 0 && (entries.length === 0 || (attested.size > 0 && removable.includes(PI_RUNTIME_ARTIFACT_MANIFEST)))) {
      for (const name of removable) {
        const artifact = path.join(state.targetDir, name);
        const artifactStat = fs.lstatSync(artifact);
        if (artifactStat.isSymbolicLink()) throw new Error("Pi provider rollback artifact is a symlink");
        fs.rmSync(artifact, { recursive: artifactStat.isDirectory(), force: true });
      }
      fs.rmdirSync(state.targetDir);
    }
  } else fs.chmodSync(state.targetDir, state.targetDirMode);
  if (state.targetDirExisted) assertPrior(state);
  fsyncDirectory(path.dirname(state.targetDir));
  releasePiProfileMigrationLock(state);
}
