import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import processInspect from "./process-inspect.cjs";

const START = "<!-- larkin:platform-rules:start -->";
const END = "<!-- larkin:platform-rules:end -->";
const START_BYTES = Buffer.from(START, "ascii");
const END_BYTES = Buffer.from(END, "ascii");
const PROMPT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const LOCK_FILE = "workspace-reconcile.lock.json";
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const MALFORMED_LOCK_GRACE_MS = 1_000;

export interface ReconcileWorkspaceOptions {
  workspaceDir: string;
  trustedWorkspaceRoot: string;
  lockDir: string;
  agentId: string;
  testHooks?: {
    beforeWrite?(file: string): void;
  };
}

interface Identity {
  dev: number;
  ino: number;
}

interface PromptPlan {
  file: string;
  current: Buffer;
  next: Buffer;
  spans: Array<{ start: number; length: number }>;
  mode: number;
  identity: Identity;
  fd: number;
}

interface LockRecord {
  pid: number;
  processStartToken: string;
  nonce: string;
  startedAt: string;
}

interface LockSnapshot {
  record: LockRecord | null;
  identity: Identity;
  ageMs: number;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function identity(stat: fs.Stats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function occurrences(content: Buffer, marker: Buffer): number[] {
  const found: number[] = [];
  for (let at = content.indexOf(marker); at >= 0; at = content.indexOf(marker, at + marker.length)) found.push(at);
  return found;
}

function promptMigration(content: Buffer, file: string): { next: Buffer; spans: Array<{ start: number; length: number }> } {
  const starts = occurrences(content, START_BYTES);
  const ends = occurrences(content, END_BYTES);
  if (starts.length === 0 && ends.length === 0) return { next: content, spans: [] };
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(`managed prompt markers are malformed or duplicate: ${file}`);
  }
  const start = starts[0];
  const length = ends[0] + END_BYTES.length - start;
  const next = Buffer.from(content);
  next.fill(0x20, start, start + length);
  return { next, spans: [{ start, length }] };
}

function readStableFd(fd: number, label: string): Buffer {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(`prompt is no longer a regular file: ${label}`);
    const size = before.size;
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, content, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (offset === size && after.size === size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs) {
      return content;
    }
  }
  throw new Error(`owner prompt remained under sustained concurrent writes: ${label}`);
}

function promptPlan(file: string): PromptPlan | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`unsafe prompt symlink: ${file}`);
  if (!stat.isFile()) throw new Error(`prompt path is not a regular file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(opened), identity(stat))) {
      throw new Error(`prompt changed while opening: ${file}`);
    }
    const current = readStableFd(fd, file);
    const migration = promptMigration(current, file);
    return { file, current, ...migration, mode: opened.mode & 0o777, identity: identity(opened), fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertPromptUnchanged(plan: PromptPlan): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(plan.file); }
  catch { throw new Error(`owner prompt changed concurrently: ${plan.file}`); }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      !sameIdentity(identity(stat), plan.identity) || (stat.mode & 0o777) !== plan.mode) {
    throw new Error(`owner prompt inode or mode changed concurrently: ${plan.file}`);
  }
  const opened = fs.fstatSync(plan.fd);
  if (!opened.isFile() || !sameIdentity(identity(opened), plan.identity) || (opened.mode & 0o777) !== plan.mode) {
    throw new Error(`owner prompt descriptor changed concurrently: ${plan.file}`);
  }
  const current = readStableFd(plan.fd, plan.file);
  if (!current.equals(plan.current)) throw new Error(`owner prompt content changed concurrently: ${plan.file}`);
}

function directoryIdentity(file: string, label: string): Identity {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is no longer a stable directory: ${file}`);
  return identity(stat);
}

function assertDirectoryIdentity(file: string, expected: Identity, label: string): void {
  let current: Identity;
  try { current = directoryIdentity(file, label); }
  catch { throw new Error(`${label} changed during workspace reconciliation: ${file}`); }
  if (!sameIdentity(current, expected)) throw new Error(`${label} inode changed during workspace reconciliation: ${file}`);
}

function closePromptPlan(plan: PromptPlan): void {
  try { fs.closeSync(plan.fd); } catch { /* already closed during cleanup */ }
}

function writeManagedSpans(plan: PromptPlan, beforeWrite?: (file: string) => void): void {
  assertPromptUnchanged(plan);
  const fd = fs.openSync(plan.file, fs.constants.O_RDWR | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(opened), plan.identity) || (opened.mode & 0o777) !== plan.mode) {
      throw new Error(`owner prompt changed while opening for migration: ${plan.file}`);
    }
    beforeWrite?.(plan.file);
    assertPromptUnchanged(plan);
    const current = readStableFd(fd, plan.file);
    if (!current.equals(plan.current)) throw new Error(`owner prompt content changed concurrently: ${plan.file}`);
    for (const span of plan.spans) {
      const blank = Buffer.alloc(span.length, 0x20);
      let offset = 0;
      while (offset < blank.length) {
        const written = fs.writeSync(fd, blank, offset, blank.length - offset, span.start + offset);
        if (written === 0) throw new Error(`managed prompt migration made no write progress: ${plan.file}`);
        offset += written;
      }
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd);
    const canonical = fs.lstatSync(plan.file);
    if (!after.isFile() || !sameIdentity(identity(after), plan.identity) || (after.mode & 0o777) !== plan.mode ||
        after.size !== plan.current.length || canonical.isSymbolicLink() || !canonical.isFile() ||
        !sameIdentity(identity(canonical), plan.identity) || canonical.size !== plan.current.length) {
      throw new Error(`owner prompt inode, mode, or size changed during migration: ${plan.file}`);
    }
    const installed = readStableFd(fd, plan.file);
    if (!installed.equals(plan.next)) throw new Error(`managed prompt migration readback mismatch: ${plan.file}`);
  } finally {
    fs.closeSync(fd);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockRecord(): LockRecord {
  const inspected = processInspect.inspectProcess(process.pid);
  if (!inspected?.ok || !inspected.startToken) {
    throw new Error(`workspace reconciliation cannot establish process ownership (${inspected?.reason || "inspection failed"})`);
  }
  return {
    pid: process.pid,
    processStartToken: inspected.startToken,
    nonce: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LockRecord>;
  return Number.isInteger(record.pid) && Number(record.pid) > 0 &&
    typeof record.processStartToken === "string" && record.processStartToken.length > 0 &&
    typeof record.nonce === "string" && record.nonce.length > 0 &&
    typeof record.startedAt === "string";
}

function createLockFile(file: string, record: LockRecord): Identity | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return null;
    throw error;
  }
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(fd);
    return identity(fs.fstatSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

function readLockSnapshot(file: string): LockSnapshot | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (isMissing(error)) return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workspace reconciliation lock path is unsafe");
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW); }
  catch (error) { if (isMissing(error)) return null; throw error; }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(opened), identity(stat))) return null;
    let parsed: unknown = null;
    try { parsed = JSON.parse(fs.readFileSync(fd, "utf8")); } catch { /* malformed/in-flight record */ }
    return {
      record: isLockRecord(parsed) ? parsed : null,
      identity: identity(opened),
      ageMs: Math.max(0, Date.now() - opened.mtimeMs),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function lockState(snapshot: LockSnapshot): "live" | "stale" | "unknown" {
  if (!snapshot.record) return snapshot.ageMs >= MALFORMED_LOCK_GRACE_MS ? "stale" : "unknown";
  if (!processInspect.pidAlive(snapshot.record.pid)) return "stale";
  const inspected = processInspect.inspectProcess(snapshot.record.pid);
  if (!inspected?.ok || !inspected.startToken) {
    return processInspect.pidAlive(snapshot.record.pid) ? "unknown" : "stale";
  }
  return inspected.startToken === snapshot.record.processStartToken ? "live" : "stale";
}

function unlinkIfIdentity(file: string, expected: Identity): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (isMissing(error)) return false; throw error; }
  if (!stat.isFile() || !sameIdentity(identity(stat), expected)) return false;
  fs.unlinkSync(file);
  return true;
}

function tryAcquireReclaimGuard(file: string, record: LockRecord): (() => void) | null {
  let guardIdentity = createLockFile(file, record);
  if (!guardIdentity) {
    const existing = readLockSnapshot(file);
    if (!existing || lockState(existing) !== "stale" || !unlinkIfIdentity(file, existing.identity)) return null;
    guardIdentity = createLockFile(file, record);
    if (!guardIdentity) return null;
  }
  const ownedIdentity = guardIdentity;
  return () => {
    try {
      const current = readLockSnapshot(file);
      if (current?.record?.pid === record.pid && current.record.nonce === record.nonce &&
          sameIdentity(current.identity, ownedIdentity)) unlinkIfIdentity(file, ownedIdentity);
    } catch { /* another owner or already removed */ }
  };
}

function acquireWorkspaceLock(lockDirReal: string): () => void {
  const file = path.join(lockDirReal, LOCK_FILE);
  const reclaimFile = path.join(lockDirReal, `${LOCK_FILE}.reclaim`);
  const record = lockRecord();
  let lastOwnerPid: number | null = null;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const ownedIdentity = createLockFile(file, record);
    if (ownedIdentity) {
      return () => {
        try {
          const current = readLockSnapshot(file);
          if (current?.record?.pid === record.pid && current.record.nonce === record.nonce &&
              sameIdentity(current.identity, ownedIdentity)) unlinkIfIdentity(file, ownedIdentity);
        } catch { /* another owner or already removed */ }
      };
    }

    const observed = readLockSnapshot(file);
    if (!observed) continue;
    lastOwnerPid = observed.record?.pid || null;
    if (lockState(observed) === "stale") {
      const releaseReclaim = tryAcquireReclaimGuard(reclaimFile, record);
      if (releaseReclaim) {
        try {
          const latest = readLockSnapshot(file);
          if (latest && lockState(latest) === "stale") unlinkIfIdentity(file, latest.identity);
        } finally {
          releaseReclaim();
        }
        continue;
      }
    }
    sleepSync(LOCK_RETRY_MS);
  }
  throw new Error(`workspace reconciliation remained busy after bounded retry${lastOwnerPid ? ` (pid=${lastOwnerPid})` : ""}`);
}

export function reconcileAgentWorkspace(options: ReconcileWorkspaceOptions): { workspaceDir: string; changed: string[] } {
  const { workspaceDir, trustedWorkspaceRoot, lockDir, agentId, testHooks } = options || ({} as ReconcileWorkspaceOptions);
  if (!AGENT_ID.test(agentId || "") || agentId === "." || agentId === ".." || /[\\/]/.test(agentId || "")) {
    throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`);
  }
  if (!workspaceDir || !trustedWorkspaceRoot || !lockDir) {
    throw new Error("workspaceDir, trustedWorkspaceRoot, and lockDir are required");
  }

  const rootPath = path.resolve(trustedWorkspaceRoot);
  const workspacePath = path.resolve(workspaceDir);
  if (!inside(rootPath, workspacePath)) throw new Error(`workspace path escapes trusted workspace root: ${workspacePath}`);

  fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  if (!fs.statSync(rootPath).isDirectory()) throw new Error(`trusted workspace root is not a directory: ${rootPath}`);
  let workspaceStat: fs.Stats;
  try { workspaceStat = fs.lstatSync(workspacePath); }
  catch (error) {
    if (!isMissing(error)) throw error;
    fs.mkdirSync(workspacePath, { mode: 0o700 });
    workspaceStat = fs.lstatSync(workspacePath);
  }
  if (workspaceStat.isSymbolicLink()) throw new Error(`workspace directory symlink is unsafe: ${workspacePath}`);
  if (!fs.statSync(workspacePath).isDirectory()) throw new Error(`workspace is not a directory: ${workspacePath}`);

  const rootReal = fs.realpathSync(rootPath);
  const workspaceReal = fs.realpathSync(workspacePath);
  if (!inside(rootReal, workspaceReal)) throw new Error(`workspace realpath is outside trusted workspace root: ${workspaceReal}`);

  const lockDirPath = path.resolve(lockDir);
  fs.mkdirSync(lockDirPath, { recursive: true, mode: 0o700 });
  const lockDirReal = fs.realpathSync(lockDirPath);
  if (lockDirReal === workspaceReal || inside(workspaceReal, lockDirReal)) {
    throw new Error("workspace reconciliation lockDir must be outside the user workspace");
  }

  // From this point on, never traverse the mutable canonical bridge again. Capture stable directory identities,
  // lock through the Agent's internal state directory, and re-check all directories before preflight/write.
  const rootIdentity = directoryIdentity(rootReal, "trusted workspace root");
  const workspaceIdentity = directoryIdentity(workspaceReal, "workspace");
  const lockDirIdentity = directoryIdentity(lockDirReal, "workspace lock directory");
  const releaseLock = acquireWorkspaceLock(lockDirReal);
  const openPlans: PromptPlan[] = [];
  try {
    assertDirectoryIdentity(rootReal, rootIdentity, "trusted workspace root");
    assertDirectoryIdentity(workspaceReal, workspaceIdentity, "workspace");
    assertDirectoryIdentity(lockDirReal, lockDirIdentity, "workspace lock directory");
    const plans = PROMPT_FILES.map((name) => promptPlan(path.join(workspaceReal, name)))
      .filter((plan): plan is PromptPlan => plan !== null);
    openPlans.push(...plans);
    const changed = plans.filter((plan) => !plan.next.equals(plan.current));

    assertDirectoryIdentity(rootReal, rootIdentity, "trusted workspace root");
    assertDirectoryIdentity(workspaceReal, workspaceIdentity, "workspace");
    assertDirectoryIdentity(lockDirReal, lockDirIdentity, "workspace lock directory");
    for (const plan of plans) assertPromptUnchanged(plan);

    const writtenPlans = new Set<PromptPlan>();
    for (const plan of changed) {
      assertDirectoryIdentity(rootReal, rootIdentity, "trusted workspace root");
      assertDirectoryIdentity(workspaceReal, workspaceIdentity, "workspace");
      assertDirectoryIdentity(lockDirReal, lockDirIdentity, "workspace lock directory");
      for (const pending of plans) {
        if (!writtenPlans.has(pending)) assertPromptUnchanged(pending);
      }
      writeManagedSpans(plan, testHooks?.beforeWrite);
      writtenPlans.add(plan);
    }
    return { workspaceDir: workspaceReal, changed: changed.map((plan) => path.basename(plan.file)) };
  } finally {
    for (const plan of openPlans) closePromptPlan(plan);
    releaseLock();
  }
}
