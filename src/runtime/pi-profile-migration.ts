import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRuntimeExecutable } from "./runtime-readiness.js";
import { mergeOwnedPiSettings, parsePiExecutableVersion } from "./pi-compaction-recovery.js";
import { BUNDLED_PI_VERSION } from "./pi-provider-config.js";

const AGENT_ID = /^cli_[A-Za-z0-9]+$/;
const FILES = ["auth.json", "models.json", "settings.json"] as const;
const FILE_LIMIT = 8 * 1024 * 1024;
const SOURCE_MODES = new Set([0o600, 0o644, 0o640]);

type FileName = typeof FILES[number];
interface FileState { present: boolean; sha256?: string; bytes?: number; mode?: number; content?: string }
export interface PiProfileMigrationState {
  version: 1;
  agentId: string;
  sourceDir: string;
  sourceFiles: Record<FileName, FileState>;
  targetDir: string;
  targetDirExisted: boolean;
  targetDirMode: number;
  priorFiles: Record<FileName, FileState>;
  afterFiles: Record<FileName, FileState>;
}

export interface PiProfileMigrationPlan { state: PiProfileMigrationState; sourceBytes: Record<FileName, Buffer> }

function hash(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
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
function readRegular(file: string, label: string, required = true): { bytes: Buffer; mode: number } | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
    assertOwner(stat, label);
    if (stat.size > FILE_LIMIT) throw new Error(`${label} is too large`);
    return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return null;
    throw error;
  }
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
function sourceVersion(env: NodeJS.ProcessEnv, cwd: string): void {
  const command = String(env.LARKIN_PI_COMMAND || "pi");
  const executable = resolveRuntimeExecutable(command, env);
  if (!executable) throw new Error("外部 Pi 0.84.2 profile import requires an installed Pi executable");
  const result = spawnSync(executable, ["--version"], { cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error("external Pi version probe failed");
  try { parsePiExecutableVersion(String(result.stdout || result.stderr || "").trim()); }
  catch { throw new Error(`external Pi must be exactly ${BUNDLED_PI_VERSION}`); }
}
function mergeSettings(bytes: Buffer): Buffer {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("external Pi settings.json is invalid"); }
  return Buffer.from(`${JSON.stringify(mergeOwnedPiSettings(value), null, 2)}\n`);
}
function targetPrior(directory: string): { stat: fs.Stats | null; files: Record<FileName, FileState> } {
  const stat = assertDirectory(directory, "Pi provider target", false);
  const files = Object.fromEntries(FILES.map((name) => {
    const file = readRegular(path.join(directory, name), `Pi provider target ${name}`, false);
    if (file && file.mode !== 0o600) throw new Error("Pi provider target files must be 0600");
    return [name, safeState(file, true)];
  })) as Record<FileName, FileState>;
  return { stat, files };
}

export function preparePiProfileMigration(env: NodeJS.ProcessEnv, configDir: string, agentId: string): PiProfileMigrationPlan {
  const sourceDir = sourceDirectory(env); verifySourceProfile(sourceDir); sourceVersion(env, sourceDir);
  const sourceFiles = Object.fromEntries(FILES.map((name) => {
    const file = readRegular(path.join(sourceDir, name), `external Pi ${name}`);
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
    "settings.json": mergeSettings(sourceFiles["settings.json"].bytes),
  };
  const afterFiles = Object.fromEntries(FILES.map((name) => [name, safeState({ bytes: imported[name], mode: 0o600 }, false)])) as Record<FileName, FileState>;
  return {
    state: { version: 1, agentId, sourceDir,
      sourceFiles: Object.fromEntries(FILES.map((name) => [name, safeState(sourceFiles[name], false)])) as Record<FileName, FileState>,
      targetDir, targetDirExisted: Boolean(target.stat), targetDirMode: target.stat ? target.stat.mode & 0o777 : 0o700,
      priorFiles: target.files, afterFiles },
    sourceBytes: { "auth.json": sourceFiles["auth.json"].bytes, "models.json": sourceFiles["models.json"].bytes,
      "settings.json": imported["settings.json"] },
  };
}

export function validatePiProfileMigrationState(value: unknown): asserts value is PiProfileMigrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi profile migration state is invalid");
  const state = value as Partial<PiProfileMigrationState>;
  if (state.version !== 1 || typeof state.agentId !== "string" || !AGENT_ID.test(state.agentId)
      || typeof state.sourceDir !== "string" || typeof state.targetDir !== "string"
      || typeof state.targetDirExisted !== "boolean" || !Number.isInteger(state.targetDirMode)
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

function assertSourceUnchanged(state: PiProfileMigrationState): void {
  verifySourceProfile(state.sourceDir);
  for (const name of FILES) {
    const file = readRegular(path.join(state.sourceDir, name), `external Pi ${name}`);
    if (!file || !state.sourceFiles[name].present || hash(file.bytes) !== state.sourceFiles[name].sha256) throw new Error("external Pi profile changed; refusing migration");
  }
}
function atomicPrivateWrite(file: string, bytes: Buffer): void {
  const temp = `${file}.larkin-pi-import-${process.pid}-${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); fs.chmodSync(file, 0o600); } finally { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
}
function currentFileState(file: string): FileState { return safeState(readRegular(file, "Pi provider target file", false), false); }
function assertPrior(state: PiProfileMigrationState): void {
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    if (current.present !== prior.present || (current.present && current.sha256 !== prior.sha256)) throw new Error("Pi provider target rollback is incomplete or conflicted");
  }
}
function restoreFile(file: string, prior: FileState): void {
  if (!prior.present) { try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return; }
  if (typeof prior.content !== "string") throw new Error("Pi provider rollback bytes are missing");
  atomicPrivateWrite(file, Buffer.from(prior.content, "base64"));
  if (prior.mode !== undefined) fs.chmodSync(file, prior.mode);
}

export function applyPiProfileMigration(plan: PiProfileMigrationPlan): void {
  assertSourceUnchanged(plan.state);
  const parent = path.dirname(plan.state.targetDir); assertNoSymlinkAncestors(parent); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700);
  const existing = assertDirectory(plan.state.targetDir, "Pi provider target", false);
  if (existing && (existing.mode & 0o777) !== 0o700) throw new Error("Pi provider target must be 0700");
  if (!existing) { fs.mkdirSync(plan.state.targetDir, { mode: 0o700 }); fs.chmodSync(plan.state.targetDir, 0o700); }
  for (const name of FILES) atomicPrivateWrite(path.join(plan.state.targetDir, name), plan.sourceBytes[name]);
  for (const name of FILES) if (currentFileState(path.join(plan.state.targetDir, name)).sha256 !== plan.state.afterFiles[name].sha256) throw new Error("Pi provider import verification failed");
  fsyncDirectory(plan.state.targetDir);
}
function fsyncDirectory(directory: string): void {
  try { const fd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort on platforms without directory fsync */ }
}

export function rollbackPiProfileMigration(state: PiProfileMigrationState): void {
  validatePiProfileMigrationState(state); assertSourceUnchanged(state);
  const target = assertDirectory(state.targetDir, "Pi provider target", false);
  if (!target) {
    if (state.targetDirExisted) throw new Error("Pi provider target disappeared during rollback");
    return;
  }
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    const expected = state.afterFiles[name];
    const isPrior = current.present === prior.present && (!current.present || current.sha256 === prior.sha256);
    const isExpected = current.present && current.sha256 === expected.sha256;
    if (!isPrior && !isExpected) throw new Error("Pi provider target changed; refusing migration rollback");
  }
  for (const name of FILES) {
    const current = currentFileState(path.join(state.targetDir, name));
    const prior = state.priorFiles[name];
    const isPrior = current.present === prior.present && (!current.present || current.sha256 === prior.sha256);
    if (!isPrior) restoreFile(path.join(state.targetDir, name), prior);
  }
  if (!state.targetDirExisted) {
    const entries = fs.readdirSync(state.targetDir).filter((name) => !FILES.includes(name as FileName) && !name.startsWith(".larkin-pi-import-"));
    if (entries.length === 0) { fs.rmdirSync(state.targetDir); }
  } else fs.chmodSync(state.targetDir, state.targetDirMode);
  if (state.targetDirExisted) assertPrior(state);
  fsyncDirectory(path.dirname(state.targetDir));
}
