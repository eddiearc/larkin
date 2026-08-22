import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PI_SUBAGENT_LEDGER_FILENAME = "pi-subagent-ledger.json";
export const PI_SUBAGENT_RECORD_DIRNAME = "pi-subagent-records";
export const PI_SUBAGENT_LEDGER_VERSION = 1 as const;
export const PI_SUBAGENT_SESSION_OWNER_ENV = "LARKIN_PI_SESSION_OWNER";

export type DispatchedSubagentStatus =
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned";

export type DispatchedSubagentWakeState = "pending" | "acknowledged";

export interface DispatchedSubagentRecord {
  taskId: string;
  status: DispatchedSubagentStatus;
  dispatchedAt: number;
  lastActivityAt: number;
  outputFile?: string;
  recordFile?: string;
  reason?: string;
  wakeKey?: string;
  wakeState?: DispatchedSubagentWakeState;
  notifiedAt?: number;
}

export interface DispatchedSubagentLedger {
  version: typeof PI_SUBAGENT_LEDGER_VERSION;
  tasks: DispatchedSubagentRecord[];
}

export type PiSubagentRecordPresence = "present" | "absent" | "consumed";

export type ConsumedPiSubagentTerminalStatus = Exclude<DispatchedSubagentStatus, "dispatched" | "orphaned">;

export interface ConsumedPiSubagentTerminal {
  taskId: string;
  status: ConsumedPiSubagentTerminalStatus;
}

export interface ReconcileDispatchedSubagentsInput {
  probe?: (record: DispatchedSubagentRecord) => PiSubagentRecordPresence;
  forceMissing?: boolean;
  now?: number;
  missingReason?: string;
}

export interface ReconcileDispatchedSubagentsResult {
  ledger: DispatchedSubagentLedger;
  orphaned: DispatchedSubagentRecord[];
}

const TERMINAL_STATUSES = new Set<DispatchedSubagentStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "orphaned",
]);

const MAX_LEDGER_TASKS = 2048;

export function emptyDispatchedSubagentLedger(): DispatchedSubagentLedger {
  return { version: PI_SUBAGENT_LEDGER_VERSION, tasks: [] };
}

export function isTerminalDispatchedSubagentStatus(status: DispatchedSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function taskIdsFromCompletionKey(completionKey: string): string[] {
  return completionKey.split("|").map((part) => part.trim()).filter(Boolean);
}

export function getDispatchedSubagent(
  ledger: DispatchedSubagentLedger,
  taskId: string,
): DispatchedSubagentRecord | null {
  return ledger.tasks.find((task) => task.taskId === taskId) ?? null;
}

export function noteDispatchedSubagent(
  ledger: DispatchedSubagentLedger,
  input: { taskId: string; outputFile?: string; recordFile?: string; now?: number },
): DispatchedSubagentLedger {
  const now = input.now ?? Date.now();
  const existing = getDispatchedSubagent(ledger, input.taskId);
  if (existing) {
    if (isTerminalDispatchedSubagentStatus(existing.status)) return ledger;
    return replaceTask(ledger, {
      ...existing,
      lastActivityAt: now,
      ...(input.outputFile ? { outputFile: input.outputFile } : {}),
      ...(input.recordFile ? { recordFile: input.recordFile } : {}),
    });
  }
  return appendTask(ledger, {
    taskId: input.taskId,
    status: "dispatched",
    dispatchedAt: now,
    lastActivityAt: now,
    ...(input.outputFile ? { outputFile: input.outputFile } : {}),
    ...(input.recordFile ? { recordFile: input.recordFile } : {}),
  });
}

export function noteDispatchedSubagentTerminal(
  ledger: DispatchedSubagentLedger,
  input: {
    taskId: string;
    status?: Exclude<DispatchedSubagentStatus, "dispatched">;
    outputFile?: string;
    reason?: string;
    wakeKey?: string;
    now?: number;
  },
): DispatchedSubagentLedger {
  const now = input.now ?? Date.now();
  const status = input.status ?? "completed";
  const existing = getDispatchedSubagent(ledger, input.taskId);
  if (existing && isTerminalDispatchedSubagentStatus(existing.status)) {
    return replaceTask(ledger, {
      ...existing,
      lastActivityAt: now,
      ...(input.outputFile && !existing.outputFile ? { outputFile: input.outputFile } : {}),
    });
  }
  const next: DispatchedSubagentRecord = {
    taskId: input.taskId,
    status,
    dispatchedAt: existing?.dispatchedAt ?? now,
    lastActivityAt: now,
    wakeState: existing?.wakeState ?? "pending",
    ...(existing?.outputFile || input.outputFile
      ? { outputFile: input.outputFile ?? existing?.outputFile } : {}),
    ...(existing?.recordFile ? { recordFile: existing.recordFile } : {}),
    ...(input.reason ? { reason: input.reason } : existing?.reason ? { reason: existing.reason } : {}),
    ...(input.wakeKey ? { wakeKey: input.wakeKey } : existing?.wakeKey ? { wakeKey: existing.wakeKey } : {}),
  };
  return existing ? replaceTask(ledger, next) : appendTask(ledger, next);
}

export function noteDispatchedSubagentActivity(
  ledger: DispatchedSubagentLedger,
  input: { taskId: string; outputFile?: string; now?: number },
): DispatchedSubagentLedger {
  const existing = getDispatchedSubagent(ledger, input.taskId);
  if (!existing || isTerminalDispatchedSubagentStatus(existing.status)) return ledger;
  return replaceTask(ledger, {
    ...existing,
    lastActivityAt: input.now ?? Date.now(),
    ...(input.outputFile ? { outputFile: input.outputFile } : {}),
  });
}

export function markDispatchedSubagentOrphaned(
  ledger: DispatchedSubagentLedger,
  input: { taskId: string; reason: string; outputFile?: string; now?: number },
): { ledger: DispatchedSubagentLedger; record: DispatchedSubagentRecord | null } {
  const existing = getDispatchedSubagent(ledger, input.taskId);
  if (existing && isTerminalDispatchedSubagentStatus(existing.status)) {
    return { ledger, record: null };
  }
  const now = input.now ?? Date.now();
  const record: DispatchedSubagentRecord = {
    taskId: input.taskId,
    status: "orphaned",
    dispatchedAt: existing?.dispatchedAt ?? now,
    lastActivityAt: existing?.lastActivityAt ?? now,
    reason: input.reason,
    wakeKey: input.taskId,
    wakeState: "pending",
    ...(input.outputFile || existing?.outputFile
      ? { outputFile: input.outputFile ?? existing?.outputFile } : {}),
    ...(existing?.recordFile ? { recordFile: existing.recordFile } : {}),
  };
  return {
    ledger: existing ? replaceTask(ledger, record) : appendTask(ledger, record),
    record,
  };
}

export function reconcileDispatchedSubagents(
  ledger: DispatchedSubagentLedger,
  input: ReconcileDispatchedSubagentsInput = {},
): ReconcileDispatchedSubagentsResult {
  const now = input.now ?? Date.now();
  const orphaned: DispatchedSubagentRecord[] = [];
  let next = ledger;
  for (const task of ledger.tasks) {
    if (isTerminalDispatchedSubagentStatus(task.status)) continue;
    const current = getDispatchedSubagent(next, task.taskId) ?? task;
    const refreshed = refreshActivityFromOutput(current, now);
    if (refreshed.lastActivityAt !== current.lastActivityAt) {
      next = noteDispatchedSubagentActivity(next, {
        taskId: current.taskId,
        outputFile: refreshed.outputFile,
        now: refreshed.lastActivityAt,
      });
    }
    const probed = getDispatchedSubagent(next, current.taskId) ?? refreshed;
    const probedPresence = input.probe?.(probed);
    const presence = input.forceMissing
      ? (probedPresence === "consumed" ? "consumed" : "absent")
      : (probedPresence ?? "present");
    if (presence === "consumed") {
      next = noteConsumedDispatchedSubagent(next, {
        taskId: current.taskId,
        status: readConsumedPiSubagentTerminal(current.recordFile)?.status ?? "completed",
        outputFile: current.outputFile,
        now,
      });
      retireConsumedPiSubagentRecord(current.recordFile);
      continue;
    }
    if (presence !== "absent") continue;
    const marked = markDispatchedSubagentOrphaned(next, {
      taskId: current.taskId,
      reason: input.missingReason ?? (input.forceMissing ? "pi session gone" : "pi record missing"),
      outputFile: current.outputFile,
      now,
    });
    next = marked.ledger;
    if (marked.record) orphaned.push(marked.record);
  }
  return { ledger: next, orphaned };
}

export function noteDispatchedSubagentWakeAcknowledged(
  ledger: DispatchedSubagentLedger,
  input: { completionKey: string; now?: number },
): DispatchedSubagentLedger {
  const now = input.now ?? Date.now();
  let next = ledger;
  for (const taskId of taskIdsFromCompletionKey(input.completionKey)) {
    const existing = getDispatchedSubagent(next, taskId);
    if (!existing || !isTerminalDispatchedSubagentStatus(existing.status)) continue;
    if (existing.wakeState === "acknowledged") continue;
    next = replaceTask(next, { ...existing, wakeState: "acknowledged", notifiedAt: now });
  }
  return next;
}

export function undeliveredTerminalWakeKeys(ledger: DispatchedSubagentLedger): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const task of ledger.tasks) {
    if (!needsTerminalWake(task)) continue;
    const key = task.wakeKey ?? task.taskId;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function noteConsumedDispatchedSubagent(
  ledger: DispatchedSubagentLedger,
  input: {
    taskId: string;
    status?: ConsumedPiSubagentTerminalStatus;
    outputFile?: string;
    now?: number;
  },
): DispatchedSubagentLedger {
  const now = input.now ?? Date.now();
  const next = noteDispatchedSubagentTerminal(ledger, {
    taskId: input.taskId,
    status: input.status ?? "completed",
    outputFile: input.outputFile,
    wakeKey: input.taskId,
    now,
  });
  return noteDispatchedSubagentWakeAcknowledged(next, { completionKey: input.taskId, now });
}

export function isConsumedTerminalPiSubagentRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const value = record as { status?: unknown; resultConsumed?: unknown };
  if (value.resultConsumed !== true) return false;
  return typeof value.status === "string" && value.status.length > 0
    && value.status !== "running" && value.status !== "queued";
}

export function ledgerStatusFromPiSubagentRecord(record: unknown): ConsumedPiSubagentTerminalStatus {
  const status = typeof record === "object" && record && "status" in record
    ? String((record as { status?: unknown }).status || "").trim().toLowerCase()
    : "";
  if (status === "error") return "failed";
  if (status === "aborted") return "timed_out";
  if (status === "stopped") return "cancelled";
  if (status === "steered") return "timed_out";
  return "completed";
}

export function readConsumedPiSubagentTerminal(file: string | undefined): ConsumedPiSubagentTerminal | null {
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConsumedPiSubagentTerminal> & {
      resultConsumed?: unknown;
      consumed?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.resultConsumed !== true && parsed.consumed !== true) return null;
    if (typeof parsed.taskId !== "string" || parsed.taskId.length === 0) return null;
    if (parsed.status !== "completed" && parsed.status !== "failed"
      && parsed.status !== "cancelled" && parsed.status !== "timed_out") {
      return null;
    }
    return { taskId: parsed.taskId, status: parsed.status };
  } catch {
    return null;
  }
}

export function writeConsumedPiSubagentTerminal(
  file: string,
  input: ConsumedPiSubagentTerminal,
): void {
  const existing = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (existing?.isSymbolicLink()) throw new Error("subagent record file must not be a symlink");
  const owner = readPiSubagentRecordOwner(file);
  fs.writeFileSync(file, `${JSON.stringify({
    taskId: input.taskId,
    resultConsumed: true,
    status: input.status,
    ...(owner ? { owner } : {}),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function retireConsumedPiSubagentRecord(file: string | undefined): boolean {
  if (!file || !readConsumedPiSubagentTerminal(file)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Probe the Pi task record sidecar. A leftover transcript is never presence. */
export function probePiSubagentRecord(record: DispatchedSubagentRecord): PiSubagentRecordPresence {
  if (!record.recordFile) return "absent";
  try {
    const stat = fs.lstatSync(record.recordFile);
    if (stat.isSymbolicLink() || !stat.isFile()) return "absent";
    if (readConsumedPiSubagentTerminal(record.recordFile)) return "consumed";
    return "present";
  } catch {
    return "absent";
  }
}

/** @deprecated Use probePiSubagentRecord. Transcript leftovers are not presence. */
export function probePiSubagentOutputRecord(record: DispatchedSubagentRecord): PiSubagentRecordPresence {
  return probePiSubagentRecord(record);
}

export function dispatchedSubagentRecordDir(stateDir: string): string {
  return path.join(stateDir, PI_SUBAGENT_RECORD_DIRNAME);
}

export function dispatchedSubagentRecordFile(stateDir: string, taskId: string): string {
  return path.join(dispatchedSubagentRecordDir(stateDir), taskId);
}

export function writeDispatchedSubagentRecordFile(
  stateDir: string | undefined,
  taskId: string,
  owner?: string,
): string | undefined {
  if (!stateDir || !taskId) return undefined;
  const dir = dispatchedSubagentRecordDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = dispatchedSubagentRecordFile(stateDir, taskId);
  const existing = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (existing?.isSymbolicLink()) throw new Error("subagent record file must not be a symlink");
  const normalizedOwner = typeof owner === "string" && owner.trim() ? owner.trim() : undefined;
  fs.writeFileSync(file, `${JSON.stringify({
    taskId,
    ...(normalizedOwner ? { owner: normalizedOwner } : {}),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function sweepAbsentPiSubagentRecordFiles(
  recordDir: string,
  getRecord: (taskId: string) => unknown,
  options?: { owner?: string },
): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(recordDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const file = path.join(recordDir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch {
      continue;
    }
    const owner = typeof options?.owner === "string" && options.owner.trim() ? options.owner.trim() : undefined;
    if (owner && readPiSubagentRecordOwner(file) !== owner) continue;
    const record = getRecord(name);
    if (isConsumedTerminalPiSubagentRecord(record)) {
      try {
        writeConsumedPiSubagentTerminal(file, {
          taskId: name,
          status: ledgerStatusFromPiSubagentRecord(record),
        });
      } catch {
        // Keep the sidecar; the next sweep retries the consumed bridge.
      }
      continue;
    }
    if (record != null) continue;
    if (readConsumedPiSubagentTerminal(file)) continue;
    try {
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      // Best-effort: the next sweep retries.
    }
  }
  return removed;
}

export function ledgerFilePath(stateDir: string | undefined): string | null {
  return stateDir ? path.join(stateDir, PI_SUBAGENT_LEDGER_FILENAME) : null;
}

export function readDispatchedSubagentLedger(file: string | null): DispatchedSubagentLedger {
  if (!file) return emptyDispatchedSubagentLedger();
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("subagent ledger is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DispatchedSubagentLedger>;
    return normalizeLedger(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDispatchedSubagentLedger();
    throw error;
  }
}

export function writeDispatchedSubagentLedger(file: string | null, ledger: DispatchedSubagentLedger): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (existing?.isSymbolicLink()) throw new Error("subagent ledger must not be a symlink");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function extractBackgroundPiSubagentDispatch(event: {
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
  isError?: unknown;
}): { taskId: string; outputFile?: string } | null {
  if (event.isError === true) return null;
  if (String(event.toolName || "") !== "Agent") return null;
  const args = asRecord(event.args);
  const resultText = collectResultText(event.result);
  const details = asRecord(asRecord(event.result)?.details);
  const backgroundByArgs = args?.run_in_background === true;
  const backgroundByResult = /Agent (?:started|queued) in background/i.test(resultText);
  if (!backgroundByArgs && !backgroundByResult) return null;
  const taskId = firstNonEmpty(
    stringValue(details?.agentId),
    stringValue(details?.id),
    matchCapture(resultText, /Agent ID:\s*(\S+)/i),
  );
  if (!taskId) return null;
  const outputFile = firstNonEmpty(
    stringValue(details?.outputFile),
    matchCapture(resultText, /Output file:\s*(\S+)/i),
  );
  return outputFile ? { taskId, outputFile } : { taskId };
}

function refreshActivityFromOutput(task: DispatchedSubagentRecord, now: number): DispatchedSubagentRecord {
  if (!task.outputFile) return task;
  try {
    const mtimeMs = fs.statSync(task.outputFile).mtimeMs;
    if (Number.isFinite(mtimeMs) && mtimeMs > task.lastActivityAt) {
      return { ...task, lastActivityAt: Math.min(now, Math.floor(mtimeMs)) };
    }
  } catch {
    // Missing output files are handled by the probe, not activity refresh.
  }
  return task;
}

function normalizeLedger(value: Partial<DispatchedSubagentLedger> | null | undefined): DispatchedSubagentLedger {
  const tasks = Array.isArray(value?.tasks) ? value.tasks.filter(isPersistedTask) : [];
  return { version: PI_SUBAGENT_LEDGER_VERSION, tasks: capLedgerTasks(tasks) };
}

function isAcknowledgedTerminalTask(task: DispatchedSubagentRecord): boolean {
  return isTerminalDispatchedSubagentStatus(task.status) && task.wakeState === "acknowledged";
}

function capLedgerTasks(tasks: DispatchedSubagentRecord[]): DispatchedSubagentRecord[] {
  if (tasks.length <= MAX_LEDGER_TASKS) return tasks;
  const overflow = tasks.length - MAX_LEDGER_TASKS;
  const evict = new Set<number>();
  for (let index = 0; index < tasks.length && evict.size < overflow; index += 1) {
    if (isAcknowledgedTerminalTask(tasks[index]!)) evict.add(index);
  }
  if (evict.size === 0) return tasks;
  return tasks.filter((_, index) => !evict.has(index));
}

function readPiSubagentRecordOwner(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { owner?: unknown };
    return typeof parsed?.owner === "string" && parsed.owner.trim() ? parsed.owner.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isPersistedTask(value: unknown): value is DispatchedSubagentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DispatchedSubagentRecord>;
  return typeof record.taskId === "string" && record.taskId.length > 0
    && typeof record.status === "string"
    && ["dispatched", "completed", "failed", "cancelled", "timed_out", "orphaned"].includes(record.status)
    && Number.isFinite(record.dispatchedAt)
    && Number.isFinite(record.lastActivityAt)
    && (record.recordFile === undefined || (typeof record.recordFile === "string" && record.recordFile.length > 0))
    && (record.wakeState === undefined || record.wakeState === "pending" || record.wakeState === "acknowledged");
}

function needsTerminalWake(task: DispatchedSubagentRecord): boolean {
  if (!isTerminalDispatchedSubagentStatus(task.status)) return false;
  if (task.wakeState === "acknowledged") return false;
  if (task.wakeState === "pending") return true;
  return task.notifiedAt == null;
}

function appendTask(ledger: DispatchedSubagentLedger, record: DispatchedSubagentRecord): DispatchedSubagentLedger {
  return normalizeLedger({ version: PI_SUBAGENT_LEDGER_VERSION, tasks: [...ledger.tasks, record] });
}

function replaceTask(ledger: DispatchedSubagentLedger, record: DispatchedSubagentRecord): DispatchedSubagentLedger {
  return {
    version: PI_SUBAGENT_LEDGER_VERSION,
    tasks: ledger.tasks.map((task) => task.taskId === record.taskId ? record : task),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function matchCapture(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match?.[1] ? match[1].trim() : null;
}

function collectResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (!record) return "";
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content.map((part) => {
      if (typeof part === "string") return part;
      const item = asRecord(part);
      return typeof item?.text === "string" ? item.text : "";
    }).join("\n");
  }
  return typeof record.text === "string" ? record.text : "";
}
