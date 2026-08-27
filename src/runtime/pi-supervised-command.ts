import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export const DEFAULT_WAIT_SECONDS = 60;
export const DEFAULT_LIFE_SECONDS = 600;
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

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
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
    this.chunks.push(chunk);
    let total = this.chunks.reduce((n, c) => n + c.length, 0);
    while (total > MAX_STREAM_BYTES && this.chunks.length > 1) {
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
}

const handles = new Map<string, HandleRecord>();

function notify(record: HandleRecord): void {
  const waiters = record.exitWaiters.splice(0);
  for (const wake of waiters) wake();
}

export function startSupervisedCommand(input: {
  owner: object;
  executable: string;
  args: string[];
  cwd?: string;
}): { handle: string; pid: number } {
  if (typeof input.executable !== "string" || input.executable.length === 0) {
    throw new Error("executable must be a non-empty string");
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be a string array");
  }
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
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
  };
  child.stdout?.on("data", (chunk: Buffer) => record.stdout.write(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => record.stderr.write(Buffer.from(chunk)));
  child.once("exit", (code) => {
    if (record.status === "running") {
      record.status = "exited";
      record.exitCode = code;
    }
    notify(record);
  });
  child.once("error", () => {
    if (record.status === "running") record.status = "killed";
    notify(record);
  });
  const lifetime = setTimeout(() => {
    if (record.status !== "running") return;
    record.status = "lifetime_exceeded";
    killProcessTree(record.pid);
  }, supervisedLifeSeconds() * 1000);
  lifetime.unref?.();
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

export async function waitSupervisedCommand(owner: object, handle: string, timeoutSeconds?: number): Promise<SupervisedSnapshot> {
  const record = requireHandle(owner, handle);
  const cap = supervisedWaitSeconds();
  const requested = typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds : cap;
  if (requested > cap) throw new Error(`wait timeout:${requested} exceeds the ${cap}s supervised wait limit`);
  const remainingLife = Math.max(0, record.deadlineAt - Date.now());
  const waitMs = Math.min(requested * 1000, remainingLife, cap * 1000);
  if (record.status === "running" && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      record.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (record.status !== "running" && record.terminalConsumed) {
    throw new Error("supervised terminal result already consumed");
  }
  const result = snapshot(record);
  if (result.status !== "running") record.terminalConsumed = true;
  return result;
}

export async function cancelSupervisedCommand(owner: object, handle: string): Promise<SupervisedSnapshot> {
  const record = requireHandle(owner, handle);
  if (record.status === "running") {
    record.status = "killed";
    killProcessTree(record.pid);
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
  return result;
}

export async function reapSupervisedCommands(owner: object): Promise<void> {
  const owned = [...handles.values()].filter((record) => record.owner === owner);
  await Promise.all(owned.map(async (record) => {
    try { await cancelSupervisedCommand(owner, record.id); }
    catch { /* already consumed or gone */ }
    handles.delete(record.id);
  }));
}
