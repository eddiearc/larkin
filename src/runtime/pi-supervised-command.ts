import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("supervised cwd must not be a symlink");
  const base = fs.realpathSync(root);
  const target = requested && requested.length > 0 ? path.resolve(base, requested) : base;
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("supervised cwd escapes the session root");
  let current = base;
  if (relative && relative !== ".") {
    for (const part of relative.split(path.sep)) {
      if (!part || part === ".") continue;
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("supervised cwd must not be a symlink");
    }
  }
  const real = fs.realpathSync(current);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (real !== base && !real.startsWith(prefix)) throw new Error("supervised cwd escapes the session root");
  if (!fs.statSync(real).isDirectory()) throw new Error("supervised cwd is not a directory");
  return real;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listDescendantPids(root: number): number[] {
  if (process.platform === "win32") return [];
  const found = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    const listed = spawnSync("pgrep", ["-P", String(current)], { encoding: "utf8" });
    if (listed.status !== 0 || !listed.stdout) continue;
    for (const line of listed.stdout.split(/\s+/)) {
      const child = Number.parseInt(line, 10);
      if (!Number.isInteger(child) || child <= 0 || found.has(child) || child === root) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

function refreshTreePids(pid: number, known: Set<number>): number[] {
  known.add(pid);
  for (const child of listDescendantPids(pid)) known.add(child);
  return [...known];
}

async function killProcessTree(pid: number, known: Set<number> = new Set([pid])): Promise<void> {
  const descendants = refreshTreePids(pid, known).filter((child) => child !== pid);
  if (process.platform === "win32") {
    const result = await new Promise<{ status: number | null; error?: Error }>((resolve) => {
      const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      child.once("error", (error) => resolve({ status: null, error }));
      child.once("exit", (status) => resolve({ status }));
    });
    if (result.error && pidAlive(pid)) throw result.error;
  } else {
    for (const child of [...descendants].reverse()) {
      try { process.kill(child, "SIGKILL"); } catch { /* already dead */ }
    }
    try { process.kill(-pid, "SIGKILL"); }
    catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
  const started = Date.now();
  const pending = () => pidAlive(pid) || descendants.some((child) => pidAlive(child));
  while (pending() && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (process.platform !== "win32") {
      for (const child of descendants) {
        try { process.kill(child, "SIGKILL"); } catch { /* already dead */ }
      }
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
  if (pending()) throw new Error(`supervised process tree ${pid} still alive`);
}

class ByteCursor {
  private chunks: Buffer[] = [];
  private dropped = 0;
  write(chunk: Buffer): void {
    let data = chunk;
    if (chunk.length > MAX_STREAM_BYTES) {
      this.dropped += chunk.length - MAX_STREAM_BYTES;
      data = chunk.subarray(chunk.length - MAX_STREAM_BYTES);
    }
    this.chunks.push(data);
    let total = this.chunks.reduce((n, c) => n + c.length, 0);
    while (total > MAX_STREAM_BYTES && this.chunks.length) {
      const overflow = total - MAX_STREAM_BYTES;
      const head = this.chunks[0];
      if (head.length <= overflow) {
        this.chunks.shift();
        this.dropped += head.length;
        total -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.dropped += overflow;
        total -= overflow;
      }
    }
  }
  snapshot(cursor: number): { text: string; cursor: number; truncated: boolean } {
    const joined = Buffer.concat(this.chunks);
    let start = Math.max(0, cursor - this.dropped);
    if (start < joined.length) {
      while (start < joined.length && (joined[start] & 0b1100_0000) === 0b1000_0000) start++;
    }
    let end = joined.length;
    if (end > start) {
      let cont = 0;
      let i = end;
      while (i > start && (joined[i - 1] & 0b1100_0000) === 0b1000_0000) {
        i--;
        cont++;
      }
      if (i > start) {
        const lead = joined[i - 1];
        const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
        if (cont + 1 < need) end = i - 1;
      }
    }
    const slice = joined.subarray(Math.min(start, end), end);
    return {
      text: slice.toString("utf8"),
      cursor: this.dropped + end,
      truncated: this.dropped > cursor || start > Math.max(0, cursor - this.dropped),
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
  cancelRequested: boolean;
  exitWaiters: Array<() => void>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  treePoll?: ReturnType<typeof setInterval>;
  treePids: Set<number>;
  chain: Promise<void>;
  closed: Promise<void>;
}

const handles = new Map<string, HandleRecord>();
const terminals = new Map<string, { owner: object; snapshot: SupervisedSnapshot }>();
const MAX_TERMINALS = 32;

function rememberTerminal(id: string, owner: object, snapshot: SupervisedSnapshot): void {
  terminals.set(id, { owner, snapshot });
  while (terminals.size > MAX_TERMINALS) {
    const oldest = terminals.keys().next().value;
    if (!oldest) break;
    terminals.delete(oldest);
  }
}

function notify(record: HandleRecord): void {
  const waiters = record.exitWaiters.splice(0);
  for (const wake of waiters) wake();
}

function finish(record: HandleRecord, status: HandleRecord["status"], exitCode: number | null): void {
  if (record.lifetimeTimer) {
    clearTimeout(record.lifetimeTimer);
    record.lifetimeTimer = undefined;
  }
  if (record.treePoll) {
    clearInterval(record.treePoll);
    record.treePoll = undefined;
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
  let record: HandleRecord | undefined;
  child.on("error", (error) => {
    if (!record) return;
    const current = record;
    void current.chain.then(async () => {
      await killProcessTree(current.pid, current.treePids);
      finish(current, "killed", null);
    });
    void error;
  });
  if (!child.pid) throw new Error("failed to spawn supervised command");
  const id = randomBytes(16).toString("hex");
  record = {
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
    cancelRequested: false,
    exitWaiters: [],
    treePids: new Set([child.pid]),
    chain: Promise.resolve(),
    closed: Promise.resolve(),
  };
  const started = record;
  let markClosed = (): void => {};
  started.closed = new Promise<void>((resolve) => { markClosed = resolve; });
  child.stdout?.on("data", (chunk: Buffer) => started.stdout.write(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => started.stderr.write(Buffer.from(chunk)));
  started.treePoll = setInterval(() => {
    refreshTreePids(started.pid, started.treePids);
  }, 50);
  started.treePoll.unref?.();
  child.once("close", (code) => {
    markClosed();
    void started.chain.then(async () => {
      await killProcessTree(started.pid, started.treePids);
      finish(started, "exited", code);
    });
  });
  started.lifetimeTimer = setTimeout(() => {
    void started.chain.then(async () => {
      if (started.status !== "running") return;
      await killProcessTree(started.pid, started.treePids);
      finish(started, "lifetime_exceeded", null);
    });
  }, supervisedLifeSeconds() * 1000);
  started.lifetimeTimer.unref?.();
  handles.set(id, started);
  return { handle: id, pid: started.pid };
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
  const remembered = terminals.get(handle);
  if (remembered && remembered.owner === owner && !handles.has(handle)) return remembered.snapshot;
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
      rememberTerminal(record.id, owner, result);
      handles.delete(record.id);
    }
    return result;
  });
}

export async function cancelSupervisedCommand(owner: object, handle: string): Promise<SupervisedSnapshot> {
  const remembered = terminals.get(handle);
  if (remembered && remembered.owner === owner && !handles.has(handle)) return remembered.snapshot;
  const record = requireHandle(owner, handle);
  return enqueue(record, async () => {
    record.cancelRequested = true;
    notify(record);
    if (record.status === "running") {
      await killProcessTree(record.pid, record.treePids);
      record.status = "killed";
    }
    if (record.lifetimeTimer) {
      clearTimeout(record.lifetimeTimer);
      record.lifetimeTimer = undefined;
    }
    await record.closed;
    const result = record.terminalConsumed && remembered?.owner === owner
      ? remembered.snapshot
      : snapshot(record);
    record.terminalConsumed = true;
    rememberTerminal(record.id, owner, result);
    handles.delete(record.id);
    return result;
  });
}

export async function reapSupervisedCommands(owner: object): Promise<void> {
  for (const [id, remembered] of terminals) {
    if (remembered.owner === owner) terminals.delete(id);
  }
  const owned = [...handles.values()].filter((record) => record.owner === owner);
  const errors: unknown[] = [];
  await Promise.all(owned.map(async (record) => {
    try { await cancelSupervisedCommand(owner, record.id); }
    catch (error) { errors.push(error); }
    if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
    try { await killProcessTree(record.pid, record.treePids); }
    catch (error) { errors.push(error); }
    handles.delete(record.id);
  }));
  if (errors.length > 0) throw errors[0];
}
