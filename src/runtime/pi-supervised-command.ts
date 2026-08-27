import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WAIT_SECONDS = 60;
export const DEFAULT_LIFE_SECONDS = 600;
export const LARKIN_SUPERVISED_COMMAND_CAPABILITY = "larkin-pi-supervised-command-v1";
const MAX_STREAM_BYTES = 64 * 1024;

export function supervisedWaitSeconds(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, DEFAULT_WAIT_SECONDS);
  return DEFAULT_WAIT_SECONDS;
}

export function supervisedLifeSeconds(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, DEFAULT_LIFE_SECONDS);
  return DEFAULT_LIFE_SECONDS;
}

export function resolveSupervisedCwd(root: string, requested?: string): string {
  if (typeof root !== "string" || root.length === 0) throw new Error("supervised cwd root is required");
  const base = fs.realpathSync(root);
  const target = requested && requested.length > 0 ? path.resolve(base, requested) : base;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("supervised cwd must not be a symlink");
  const real = fs.realpathSync(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (real !== base && !real.startsWith(prefix)) throw new Error("supervised cwd escapes the session root");
  if (!fs.statSync(real).isDirectory()) throw new Error("supervised cwd is not a directory");
  return real;
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      const done = () => resolve();
      child.once("exit", done);
      child.once("error", done);
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

class ByteCursor {
  private chunks: Buffer[] = [];
  private dropped = 0;
  write(chunk: Buffer): void {
    let data = chunk.length > MAX_STREAM_BYTES ? chunk.subarray(chunk.length - MAX_STREAM_BYTES) : chunk;
    this.chunks.push(data);
    let total = this.chunks.reduce((n, c) => n + c.length, 0);
    while (total > MAX_STREAM_BYTES && this.chunks.length) {
      const gone = this.chunks.shift();
      if (!gone) break;
      this.dropped += gone.length;
      total -= gone.length;
    }
  }
  snapshot(cursor: number): { text: string; cursor: number; truncated: boolean } {
    const joined = Buffer.concat(this.chunks);
    const start = Math.max(0, cursor - this.dropped);
    const slice = joined.subarray(Math.min(start, joined.length));
    return {
      text: slice.toString("utf8"),
      cursor: this.dropped + joined.length,
      truncated: this.dropped > cursor,
    };
  }
}

export interface SupervisedSnapshot {
  handle: string;
  pid: number;
  status: "running" | "exited" | "killed" | "lifetime_exceeded";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutCursor: number;
  stderrCursor: number;
  truncated: boolean;
}

interface HandleRecord {
  id: string;
  owner: object;
  child: ChildProcess;
  pid: number;
  startedAt: number;
  deadlineAt: number;
  stdout: ByteCursor;
  stderr: ByteCursor;
  stdoutCursor: number;
  stderrCursor: number;
  status: SupervisedSnapshot["status"];
  exitCode: number | null;
  terminalConsumed: boolean;
  exitWaiters: Array<() => void>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
}

const handles = new Map<string, HandleRecord>();

function notify(record: HandleRecord): void {
  const waiters = record.exitWaiters.splice(0);
  for (const wake of waiters) wake();
}

function finish(record: HandleRecord, status: HandleRecord["status"], exitCode: number | null): void {
  if (record.lifetimeTimer) {
    clearTimeout(record.lifetimeTimer);
    record.lifetimeTimer = undefined;
  }
  if (record.status === "running") {
    record.status = status;
    record.exitCode = exitCode;
  }
  notify(record);
}

export function startSupervisedCommand(input: {
  owner: object;
  executable: string;
  args: string[];
  cwd: string;
}): { handle: string; pid: number } {
  if (typeof input.executable !== "string" || input.executable.length === 0) {
    throw new Error("executable must be a non-empty string");
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be a string array");
  }
  const cwd = resolveSupervisedCwd(input.cwd);
  const child = spawn(input.executable, input.args, {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error("failed to spawn supervised command");
  const id = randomBytes(16).toString("hex");
  const record: HandleRecord = {
    id,
    owner: input.owner,
    child,
    pid: child.pid,
    startedAt: Date.now(),
    deadlineAt: Date.now() + supervisedLifeSeconds() * 1000,
    stdout: new ByteCursor(),
    stderr: new ByteCursor(),
    stdoutCursor: 0,
    stderrCursor: 0,
    status: "running",
    exitCode: null,
    terminalConsumed: false,
    exitWaiters: [],
    chain: Promise.resolve(),
  };
  child.stdout?.on("data", (chunk: Buffer) => record.stdout.write(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => record.stderr.write(Buffer.from(chunk)));
  child.once("exit", (code) => {
    void killProcessTree(record.pid).finally(() => finish(record, "exited", code));
  });
  child.once("error", () => {
    void killProcessTree(record.pid).finally(() => finish(record, "killed", null));
  });
  record.lifetimeTimer = setTimeout(() => {
    if (record.status !== "running") return;
    record.status = "lifetime_exceeded";
    void killProcessTree(record.pid);
  }, supervisedLifeSeconds() * 1000);
  record.lifetimeTimer.unref?.();
  handles.set(id, record);
  return { handle: id, pid: record.pid };
}

function snapshot(record: HandleRecord): SupervisedSnapshot {
  const out = record.stdout.snapshot(record.stdoutCursor);
  const err = record.stderr.snapshot(record.stderrCursor);
  record.stdoutCursor = out.cursor;
  record.stderrCursor = err.cursor;
  return {
    handle: record.id,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    stdout: out.text,
    stderr: err.text,
    stdoutCursor: out.cursor,
    stderrCursor: err.cursor,
    truncated: out.truncated || err.truncated,
  };
}

function requireHandle(owner: object, handle: string): HandleRecord {
  const record = handles.get(handle);
  if (!record || record.owner !== owner) throw new Error("supervised handle not found");
  return record;
}

function enqueue(record: HandleRecord, work: () => Promise<SupervisedSnapshot>): Promise<SupervisedSnapshot> {
  const next = record.chain.then(work, work);
  record.chain = next.then(() => undefined, () => undefined);
  return next;
}

export async function waitSupervisedCommand(owner: object, handle: string, timeoutSeconds?: number): Promise<SupervisedSnapshot> {
  const record = requireHandle(owner, handle);
  return enqueue(record, async () => {
    const cap = supervisedWaitSeconds();
    const requested = typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds : cap;
    if (requested > cap) throw new Error(`wait timeout:${requested} exceeds the ${cap}s supervised wait limit`);
    const remainingLife = Math.max(0, record.deadlineAt - Date.now());
    const waitMs = Math.min(requested * 1000, remainingLife, cap * 1000);
    if (record.status === "running" && waitMs > 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finishWait = () => {
          if (done) return;
          done = true;
          record.exitWaiters = record.exitWaiters.filter((item) => item !== finishWait);
          resolve();
        };
        const timer = setTimeout(finishWait, waitMs);
        record.exitWaiters.push(() => {
          clearTimeout(timer);
          finishWait();
        });
      });
    }
    if (record.status !== "running" && record.terminalConsumed) {
      throw new Error("supervised terminal result already consumed");
    }
    const result = snapshot(record);
    if (result.status !== "running") {
      record.terminalConsumed = true;
      handles.delete(record.id);
    }
    return result;
  });
}

export async function cancelSupervisedCommand(owner: object, handle: string): Promise<SupervisedSnapshot> {
  const record = requireHandle(owner, handle);
  return enqueue(record, async () => {
    if (record.status === "running") {
      record.status = "killed";
      await killProcessTree(record.pid);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        record.exitWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (record.terminalConsumed) throw new Error("supervised terminal result already consumed");
    const result = snapshot(record);
    record.terminalConsumed = true;
    if (record.lifetimeTimer) {
      clearTimeout(record.lifetimeTimer);
      record.lifetimeTimer = undefined;
    }
    handles.delete(record.id);
    return result;
  });
}

export async function reapSupervisedCommands(owner: object): Promise<void> {
  const owned = [...handles.values()].filter((record) => record.owner === owner);
  await Promise.all(owned.map(async (record) => {
    try { await cancelSupervisedCommand(owner, record.id); }
    catch { /* already consumed or gone */ }
    if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
    await killProcessTree(record.pid);
    handles.delete(record.id);
  }));
}
