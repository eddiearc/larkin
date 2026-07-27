import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import processInspectImport from "./process-inspect.cjs";

const processInspect = processInspectImport as unknown as ProcessInspectModule;

export const pidAlive = processInspect.pidAlive;
export const inspectProcess = processInspect.inspectProcess;
export const currentProcessMetadata = processInspect.currentProcessMetadata;

interface ProcessInspection {
  ok: boolean;
  dead?: boolean;
  reason?: string;
  command?: string;
  startToken?: string;
  [key: string]: unknown;
}

interface ProcessInspectModule {
  pidAlive(pid: unknown): boolean;
  inspectProcess(pid: number): ProcessInspection;
  currentProcessMetadata(commandToken: string): ProcessRecord;
}

export interface ProcessRecord {
  pid?: number | string;
  commandToken?: string;
  processStartToken?: string;
  nonce?: string;
  agents?: string[];
  [key: string]: unknown;
}

export type OwnedProcessState = "dead" | "unknown" | "mismatch" | "owned";

export interface OwnedProcessRecord extends ProcessRecord {
  file: string;
  state: OwnedProcessState;
  alive: boolean;
  running: boolean;
  reason: string | null;
  inspected?: ProcessInspection;
}

type Inspect = (pid: number) => ProcessInspection;

interface InspectOption {
  inspect?: Inspect;
}

interface LockOptions {
  malformedGraceMs?: number;
}

interface NodeError extends Error {
  code?: string;
}

export function readJson<T = null>(file: string, fallback: T = null as T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readOwnedProcessRecord(
  file: string,
  defaultCommandToken?: string,
  { inspect = inspectProcess }: InspectOption = {},
): OwnedProcessRecord {
  const record = readJson<ProcessRecord | null>(file, null);
  if (!record) return { file, state: "dead", alive: false, running: false, reason: "status missing" };
  const alive = pidAlive(record.pid);
  if (!alive) return { ...record, file, state: "dead", alive: false, running: false, reason: "pid not alive" };
  const inspected = inspect(Number(record.pid));
  if (!inspected?.ok && inspected?.dead) {
    return { ...record, file, state: "dead", alive: false, running: false, reason: inspected.reason || "process exited", inspected };
  }
  if (!inspected?.ok) {
    return {
      ...record,
      file,
      state: "unknown",
      alive: true,
      running: false,
      reason: inspected?.reason || "process inspection failed",
    };
  }
  if (
    typeof inspected.command !== "string" || !inspected.command ||
    typeof inspected.startToken !== "string" || !inspected.startToken
  ) {
    return {
      ...record,
      file,
      state: "unknown",
      alive: true,
      running: false,
      reason: "process inspection metadata incomplete",
      inspected,
    };
  }
  const commandToken = record.commandToken || defaultCommandToken;
  if (!commandToken || !inspected.command.includes(commandToken)) {
    return { ...record, file, state: "mismatch", alive: true, running: false, reason: "command mismatch", inspected };
  }
  if (!record.processStartToken) {
    return {
      ...record,
      file,
      state: "unknown",
      alive: true,
      running: false,
      reason: "status lacks processStartToken",
      inspected,
    };
  }
  if (record.processStartToken !== inspected.startToken) {
    return { ...record, file, state: "mismatch", alive: true, running: false, reason: "process start mismatch", inspected };
  }
  return { ...record, file, state: "owned", alive: true, running: true, reason: null, inspected };
}

export function readProcessState(larkinHome: string): { supervisor: OwnedProcessRecord; daemon: OwnedProcessRecord; dashboard: OwnedProcessRecord } {
  return {
    supervisor: readOwnedProcessRecord(path.join(larkinHome, "supervisor-status.json"), "app/run.mjs"),
    daemon: readOwnedProcessRecord(path.join(larkinHome, "daemon-status.json"), "app/runtime-process.mjs"),
    dashboard: readOwnedProcessRecord(path.join(larkinHome, "dashboard-status.json"), "app/dashboard.mjs"),
  };
}

export function daemonHasAgent(daemon: OwnedProcessRecord | null | undefined, agentId: string): boolean {
  return !!(daemon?.state === "owned" && Array.isArray(daemon.agents) && daemon.agents.includes(agentId));
}

export function assertProcessCanStart(record: OwnedProcessRecord | null | undefined, label: string): void {
  if (record?.state === "unknown") {
    throw new Error(`${label} PID ${record.pid} 存活但身份无法确认（${record.reason}）；为避免重复进程或误杀，已停止`);
  }
}

export function terminateOwnedProcess(
  record: Pick<OwnedProcessRecord, "file" | "pid"> & ProcessRecord,
  signal: NodeJS.Signals | number = "SIGTERM",
  { inspect = inspectProcess }: InspectOption = {},
): OwnedProcessRecord {
  const current = readOwnedProcessRecord(record.file, record.commandToken, { inspect });
  if (current.state !== "owned") {
    throw new Error(`拒绝向 PID ${record.pid} 发送 ${signal}：进程所有权=${current.state}（${current.reason}）`);
  }
  process.kill(Number(current.pid), signal);
  return current;
}

export async function waitForProcessExit(
  record: Pick<OwnedProcessRecord, "file" | "pid"> & ProcessRecord,
  timeoutMs = 10_000,
  { inspect = inspectProcess }: InspectOption = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readOwnedProcessRecord(record.file, record.commandToken, { inspect });
    if (current.state === "dead" || current.state === "mismatch") return true;
    if (current.state === "unknown") throw new Error(`等待 PID ${record.pid} 退出时无法确认所有权：${current.reason}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function atomicCreateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function tryAcquireReclaimLock(file: string, commandToken: string): (() => void) | null {
  const reclaimFile = `${file}.reclaim`;
  const metadata = currentProcessMetadata(commandToken);
  const record = { ...metadata, nonce: crypto.randomUUID(), startedAt: new Date().toISOString() };
  try {
    atomicCreateJson(reclaimFile, record);
  } catch (error) {
    if ((error as NodeError).code !== "EEXIST") throw error;
    const existing = readOwnedProcessRecord(reclaimFile, commandToken);
    if (existing.state === "owned" || existing.state === "unknown") return null;
    fs.rmSync(reclaimFile, { force: true });
    try {
      atomicCreateJson(reclaimFile, record);
    } catch (retryError) {
      if ((retryError as NodeError).code === "EEXIST") return null;
      throw retryError;
    }
  }
  return () => {
    const current = readJson<ProcessRecord | null>(reclaimFile, null);
    if (current?.nonce === record.nonce && current?.pid === process.pid) fs.rmSync(reclaimFile, { force: true });
  };
}

export function acquireProcessLock(
  file: string,
  commandToken: string,
  { malformedGraceMs = 5_000 }: LockOptions = {},
): { file: string; record: ProcessRecord; release: () => void } {
  const nonce = crypto.randomUUID();
  const metadata = currentProcessMetadata(commandToken);
  const record = { ...metadata, nonce, startedAt: new Date().toISOString() };
  let created = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      atomicCreateJson(file, record);
      created = true;
      break;
    } catch (error) {
      if ((error as NodeError).code !== "EEXIST") throw error;
      let existing: ProcessRecord | null = null;
      let malformedAge: number | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf8")) as ProcessRecord;
      } catch {
        try {
          malformedAge = Date.now() - fs.statSync(file).mtimeMs;
        } catch (statError) {
          if ((statError as NodeError).code === "ENOENT") continue;
          throw statError;
        }
      }
      if (malformedAge !== null && malformedAge < malformedGraceMs) throw new Error(`lock 正在创建，暂不能接管：${file}`);
      if (existing) {
        const state = readOwnedProcessRecord(file, existing.commandToken || commandToken);
        if (state.state === "owned" || state.state === "unknown") {
          throw new Error(`lock 已被正在运行的进程占用：${file} pid=${existing.pid} state=${state.state}`);
        }
      }
      const releaseReclaim = tryAcquireReclaimLock(file, commandToken);
      if (!releaseReclaim) continue;
      try {
        let latest: ProcessRecord | null = null;
        try {
          latest = JSON.parse(fs.readFileSync(file, "utf8")) as ProcessRecord;
        } catch {
          let age: number;
          try {
            age = Date.now() - fs.statSync(file).mtimeMs;
          } catch (statError) {
            if ((statError as NodeError).code === "ENOENT") continue;
            throw statError;
          }
          if (age < malformedGraceMs) throw new Error(`lock 正在创建，暂不能接管：${file}`);
        }
        if (latest) {
          const latestState = readOwnedProcessRecord(file, latest.commandToken || commandToken);
          if (latestState.state === "owned" || latestState.state === "unknown") {
            throw new Error(`lock 已被正在运行的进程占用：${file} pid=${latest.pid} state=${latestState.state}`);
          }
        }
        fs.rmSync(file, { force: true });
      } finally {
        releaseReclaim();
      }
    }
  }
  if (!created) throw new Error(`无法取得 lock（并发重试耗尽）：${file}`);
  const release = () => {
    const current = readJson<ProcessRecord | null>(file, null);
    if (current?.nonce === nonce && current?.pid === process.pid) fs.rmSync(file, { force: true });
  };
  return { file, record, release };
}
