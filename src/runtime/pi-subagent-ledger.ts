import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PI_SUBAGENT_LEDGER_FILENAME = "pi-subagent-ledger.json";
export const PI_SUBAGENT_LEDGER_VERSION = 1 as const;

export type DispatchedSubagentStatus =
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned";

export interface DispatchedSubagentRecord {
  taskId: string;
  status: DispatchedSubagentStatus;
  dispatchedAt: number;
  lastActivityAt: number;
  outputFile?: string;
  reason?: string;
  wakeKey?: string;
  notifiedAt?: number;
}

export interface DispatchedSubagentLedger {
  version: typeof PI_SUBAGENT_LEDGER_VERSION;
  tasks: DispatchedSubagentRecord[];
}

export type PiSubagentRecordPresence = "present" | "absent";

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
  input: { taskId: string; outputFile?: string; now?: number },
): DispatchedSubagentLedger {
  const now = input.now ?? Date.now();
  const existing = getDispatchedSubagent(ledger, input.taskId);
  if (existing) {
    if (isTerminalDispatchedSubagentStatus(existing.status)) return ledger;
    return replaceTask(ledger, {
      ...existing,
      lastActivityAt: now,
      ...(input.outputFile ? { outputFile: input.outputFile } : {}),
    });
  }
  return appendTask(ledger, {
    taskId: input.taskId,
    status: "dispatched",
    dispatchedAt: now,
    lastActivityAt: now,
    ...(input.outputFile ? { outputFile: input.outputFile } : {}),
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
      notifiedAt: existing.notifiedAt ?? now,
      ...(input.outputFile && !existing.outputFile ? { outputFile: input.outputFile } : {}),
    });
  }
  const next: DispatchedSubagentRecord = {
    taskId: input.taskId,
    status,
    dispatchedAt: existing?.dispatchedAt ?? now,
    lastActivityAt: now,
    notifiedAt: now,
    ...(existing?.outputFile || input.outputFile
      ? { outputFile: input.outputFile ?? existing?.outputFile } : {}),
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
    notifiedAt: now,
    ...(input.outputFile || existing?.outputFile
      ? { outputFile: input.outputFile ?? existing?.outputFile } : {}),
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
    const presence = input.forceMissing ? "absent" : (input.probe?.(refreshActivityFromOutput(task, now)) ?? "present");
    if (presence !== "absent") continue;
    const marked = markDispatchedSubagentOrphaned(next, {
      taskId: task.taskId,
      reason: input.missingReason ?? (input.forceMissing ? "pi session gone" : "pi record missing"),
      outputFile: task.outputFile,
      now,
    });
    next = marked.ledger;
    if (marked.record) orphaned.push(marked.record);
  }
  return { ledger: next, orphaned };
}

export function probePiSubagentOutputRecord(record: DispatchedSubagentRecord): PiSubagentRecordPresence {
  if (!record.outputFile) return "present";
  try {
    fs.accessSync(record.outputFile);
    return "present";
  } catch {
    return "absent";
  }
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
  return { version: PI_SUBAGENT_LEDGER_VERSION, tasks: tasks.slice(-MAX_LEDGER_TASKS) };
}

function isPersistedTask(value: unknown): value is DispatchedSubagentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DispatchedSubagentRecord>;
  return typeof record.taskId === "string" && record.taskId.length > 0
    && typeof record.status === "string"
    && ["dispatched", "completed", "failed", "cancelled", "timed_out", "orphaned"].includes(record.status)
    && Number.isFinite(record.dispatchedAt)
    && Number.isFinite(record.lastActivityAt);
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
