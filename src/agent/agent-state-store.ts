import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { TargetRootLayout, type AgentStatePaths } from "../platform/root-layout.js";
import { acquireProcessLock, inspectProcess } from "../platform/process-state.js";
import { isWindows } from "../platform/secure-metadata.js";
import { isCanonicalInboxTarget, targetKeyOfInboxEnvelope, type InboxEnvelope } from "./inbox-projection.js";
import { buildStrictProviderErrorInput, classifyStrictProviderError } from "../runtime/provider-error-classifier.js";

export type JsonStateKey = "agentState" | "status" | "map" | "replyctx" | "botIdentity" |
  "senderProfiles" | "readReceipts" | "pendingReact" | "runtimeDeliveries" | "inboxState" | "freshnessState" | "documentComments" | "reminders" | "interactions";
export type NdjsonStateKey = "conversation" | "inbox";

const JSON_KEYS: ReadonlySet<string> = new Set([
  "agentState", "status", "map", "replyctx", "botIdentity", "senderProfiles", "readReceipts", "pendingReact", "runtimeDeliveries", "inboxState", "freshnessState", "documentComments", "reminders", "interactions",
]);
const NDJSON_KEYS: ReadonlySet<string> = new Set(["conversation", "inbox"]);
const INBOX_LOCK_TIMEOUT_MS = 2_000;
const INBOX_MALFORMED_LOCK_GRACE_MS = 5_000;
const INBOX_LOCK_OWNER_FILE = "owner.json";

function lstatIfExists(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rejectSymlink(file: string): void {
  if (lstatIfExists(file)?.isSymbolicLink()) throw new Error(`state path must not be a symlink: ${file}`);
}

function mkdirSecure(dir: string, boundary: string): void {
  const relative = path.relative(boundary, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`state path escapes boundary: ${dir}`);
  rejectSymlink(boundary);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  let cursor = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    rejectSymlink(cursor);
    try { fs.mkdirSync(cursor, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    rejectSymlink(cursor);
    if (!fs.statSync(cursor).isDirectory()) throw new Error(`state path is not a directory: ${cursor}`);
  }
}

function validateExistingPath(file: string, boundary: string): void {
  const relative = path.relative(boundary, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`state path escapes boundary: ${file}`);
  let cursor = boundary;
  const boundaryStat = lstatIfExists(cursor);
  if (!boundaryStat) return;
  if (boundaryStat.isSymbolicLink()) throw new Error(`state path must not be a symlink: ${cursor}`);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatIfExists(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`state path must not be a symlink: ${cursor}`);
  }
}

function stringifyJson(value: unknown, pretty: boolean): string {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (text === undefined) throw new Error("state value must be JSON serializable");
  return text;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export interface InboxDrainHooks {
  /** Test/instrumentation hook that runs with the interprocess Inbox lock held. */
  afterRead?(): void;
  now?(): number;
}

export interface InboxPollOptions extends InboxDrainHooks {
  target?: string;
  limit?: number;
}

export interface InboxPollResult<T> {
  envelopes: T[];
  consumedDeliveryIds: string[];
  seenThroughSeq: number | null;
  pendingCount: number;
}

interface InboxTargetState {
  latest_received_seq: number;
  model_seen_seq: number;
}

export interface InboxDraft {
  draft_id: string;
  target: string;
  argv: string[];
  status: "held" | "sending" | "sent" | "abandoned";
  held_at_seq: number;
  created_at: string;
  updated_at: string;
  intent_id?: string;
  intent_model_seen_seq?: number;
  sending_at?: string;
}

interface InboxSendIntent {
  intent_id: string;
  target: string;
  argv: string[];
  latest_received_seq: number;
  model_seen_seq: number;
  committed_at: string;
  draft_id?: string;
}

interface InboxStateFile {
  version: 2;
  targets: Record<string, InboxTargetState>;
  messages: Record<string, { target: string; seq: number; kind?: string }>;
  drafts: Record<string, InboxDraft>;
  intents: Record<string, InboxSendIntent>;
}

export type FreshnessGateResult<T> =
  | { status: "held"; target: string; latest_received_seq: number; model_seen_seq: number; draft: InboxDraft }
  | { status: "ready"; target: string; intentId: string; result: T };

function emptyInboxState(): InboxStateFile {
  return { version: 2, targets: {}, messages: {}, drafts: {}, intents: {} };
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function normalizeInboxState(value: unknown): InboxStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyInboxState();
  const raw = value as Partial<InboxStateFile>;
  const state = emptyInboxState();
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
    for (const [target, candidate] of Object.entries(raw.targets)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const row = candidate as Partial<InboxTargetState>;
      const latest = validSequence(row.latest_received_seq) ? row.latest_received_seq : 0;
      const seen = validSequence(row.model_seen_seq) ? Math.min(row.model_seen_seq, latest) : 0;
      state.targets[target] = { latest_received_seq: latest, model_seen_seq: seen };
    }
  }
  if (raw.messages && typeof raw.messages === "object" && !Array.isArray(raw.messages)) {
    for (const [messageId, candidate] of Object.entries(raw.messages)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const row = candidate as { target?: unknown; seq?: unknown; kind?: unknown };
      if (typeof row.target === "string" && row.target && validSequence(row.seq)) state.messages[messageId] = {
        target: row.target, seq: row.seq, ...(typeof row.kind === "string" && row.kind ? { kind: row.kind } : {}),
      };
    }
  }
  if (raw.drafts && typeof raw.drafts === "object" && !Array.isArray(raw.drafts)) {
    for (const [draftId, candidate] of Object.entries(raw.drafts)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const draft = candidate as InboxDraft;
      if (draft.draft_id === draftId && typeof draft.target === "string" && Array.isArray(draft.argv)
        && draft.argv.every((argument) => typeof argument === "string") && ["held", "sending", "sent", "abandoned"].includes(draft.status)) {
        const normalized = { ...draft, argv: [...draft.argv] };
        if (normalized.status === "sending" && (typeof normalized.intent_id !== "string" || !normalized.intent_id
            || !Number.isSafeInteger(normalized.intent_model_seen_seq) || Number(normalized.intent_model_seen_seq) < 0
            || typeof normalized.sending_at !== "string" || !normalized.sending_at)) {
          normalized.status = "held";
          delete normalized.intent_id;
          delete normalized.intent_model_seen_seq;
          delete normalized.sending_at;
        }
        state.drafts[draftId] = normalized;
      }
    }
  }
  if (raw.intents && typeof raw.intents === "object" && !Array.isArray(raw.intents)) {
    for (const [intentId, candidate] of Object.entries(raw.intents)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const intent = candidate as InboxSendIntent;
      if (intent.intent_id === intentId && typeof intent.target === "string" && !!intent.target
        && Array.isArray(intent.argv) && intent.argv.every((argument) => typeof argument === "string")
        && Number.isSafeInteger(intent.latest_received_seq) && intent.latest_received_seq >= 0
        && Number.isSafeInteger(intent.model_seen_seq) && intent.model_seen_seq >= 0
        && typeof intent.committed_at === "string" && !!intent.committed_at
        && (intent.draft_id === undefined || typeof intent.draft_id === "string")) {
        state.intents[intentId] = { ...intent, argv: [...intent.argv] };
      }
    }
  }
  return state;
}

interface RuntimeDeliveryRecord extends Record<string, unknown> {
  messageId?: unknown;
  status?: unknown;
}

interface RuntimeDeliveryStore extends Record<string, unknown> {
  version?: unknown;
  records?: unknown;
}

interface InboxLockOwner {
  version: 1;
  pid: number;
  processStartToken: string;
  nonce: string;
}

type InboxLockState = "active" | "unknown" | "reclaimable";
type InspectProcess = typeof inspectProcess;

export interface AgentStateStoreDependencies {
  inspectProcess?: InspectProcess;
}

function newInboxLockOwner(inspect: InspectProcess): InboxLockOwner {
  const inspected = inspect(process.pid);
  if (!inspected.ok || !inspected.startToken) {
    throw new Error(`无法读取 Inbox lock owner 身份：${inspected.reason || "metadata incomplete"}`);
  }
  return { version: 1, pid: process.pid, processStartToken: inspected.startToken, nonce: crypto.randomUUID() };
}

function validInboxLockOwner(value: unknown): value is InboxLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<InboxLockOwner>;
  return owner.version === 1 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
    && typeof owner.processStartToken === "string" && !!owner.processStartToken
    && typeof owner.nonce === "string" && /^[0-9a-f-]{36}$/i.test(owner.nonce);
}

export type InboxDeliveryPreparation = "appended" | "present" | "active" | "terminal_error" | "consumed";

export interface ContextOverflowRearmResult {
  rearmedCount: number;
  remainingPendingCount: number;
}

export type ContextOverflowRecoveryCode = "inbox_empty" | "canonical_inbox_malformed" | "duplicate_message_id"
  | "delivery_missing" | "delivery_not_terminal" | "delivery_not_context_window" | "delivery_duplicate"
  | "delivery_identity_invalid" | "duplicate_input_id";

export class ContextOverflowRecoveryError extends Error {
  constructor(readonly code: ContextOverflowRecoveryCode, message: string) {
    super(message);
    this.name = "ContextOverflowRecoveryError";
  }
}

export type CanonicalInboxAppendResult =
  | { status: "appended" | "duplicate_pending"; envelope: InboxEnvelope }
  | { status: "duplicate_consumed"; envelope: null };

export type InboxDeliverySourceResolution =
  | { status: "pending"; target: string; envelope: InboxEnvelope }
  | { status: "consumed"; target: string }
  | { status: "missing"; code: "canonical_inbox_row_missing" }
  | { status: "invalid"; code: "canonical_inbox_malformed" | "duplicate_message_id" | "inbox_state_conflict" };

export class AgentStateStore {
  readonly paths: AgentStatePaths;
  private readonly boundary: string;
  private readonly inspect: InspectProcess;

  constructor(layout: TargetRootLayout, agentId: string, dependencies: AgentStateStoreDependencies = {}) {
    this.paths = layout.agentStatePaths(agentId);
    this.boundary = path.join(layout.root, "state");
    this.inspect = dependencies.inspectProcess ?? inspectProcess;
  }

  private file(key: JsonStateKey | NdjsonStateKey): string {
    if (!JSON_KEYS.has(key) && !NDJSON_KEYS.has(key)) throw new Error(`unknown Agent state key: ${key}`);
    const file = this.paths[key];
    const relative = path.relative(this.paths.root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`state file escapes Agent root: ${file}`);
    return file;
  }

  private prepare(file: string): void {
    mkdirSecure(this.paths.root, this.boundary);
    rejectSymlink(file);
  }

  private readInboxLockOwner(lockDir: string): InboxLockOwner | null {
    const ownerFile = path.join(lockDir, INBOX_LOCK_OWNER_FILE);
    let fd: number | null = null;
    try {
      fd = fs.openSync(ownerFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
          || (!isWindows && (stat.mode & 0o077) !== 0)) {
        throw new Error(`Inbox lock owner 文件不安全：${ownerFile}`);
      }
      const value = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
      return validInboxLockOwner(value) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private inboxLockState(lockDir: string): InboxLockState {
    const owner = this.readInboxLockOwner(lockDir);
    if (!owner) {
      const stat = lstatIfExists(lockDir);
      if (!stat) return "reclaimable";
      const age = Date.now() - stat.mtimeMs;
      return age >= INBOX_MALFORMED_LOCK_GRACE_MS ? "reclaimable" : "unknown";
    }
    const inspected = this.inspect(owner.pid);
    if (!inspected.ok) return inspected.dead ? "reclaimable" : "unknown";
    if (!inspected.startToken) return "unknown";
    return inspected.startToken === owner.processStartToken ? "active" : "reclaimable";
  }

  private removeInboxLockIfOwned(lockDir: string, owner: InboxLockOwner): void {
    const current = this.readInboxLockOwner(lockDir);
    if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce
        || current.processStartToken !== owner.processStartToken) return;
    fs.unlinkSync(path.join(lockDir, INBOX_LOCK_OWNER_FILE));
    fs.rmdirSync(lockDir);
  }

  private tryReclaimInboxLock(lockDir: string): boolean {
    const reclaimFile = `${lockDir}.reclaim`;
    rejectSymlink(reclaimFile);
    let reclaim: ReturnType<typeof acquireProcessLock>;
    try {
      reclaim = acquireProcessLock(reclaimFile, path.basename(process.execPath), {
        malformedGraceMs: INBOX_MALFORMED_LOCK_GRACE_MS,
      });
    } catch (error) {
      if (/lock 已被|无法取得 lock|正在创建|暂不能接管/.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
    try {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(lockDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error(`invalid inbox lock path: ${lockDir}`);
      }
      if (this.inboxLockState(lockDir) !== "reclaimable") return false;
      let entries: string[];
      try { entries = fs.readdirSync(lockDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (!lstatIfExists(lockDir)) return true;
          return false;
        }
        throw error;
      }
      if (entries.some((entry) => entry !== INBOX_LOCK_OWNER_FILE)) {
        throw new Error(`Inbox lock 包含未知内容，拒绝回收：${lockDir}`);
      }
      if (entries.includes(INBOX_LOCK_OWNER_FILE)) {
        const ownerFile = path.join(lockDir, INBOX_LOCK_OWNER_FILE);
        const ownerStat = lstatIfExists(ownerFile);
        if (!ownerStat) {
          if (!lstatIfExists(lockDir)) return true;
          return false;
        }
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new Error(`Inbox lock owner 路径无效：${lockDir}`);
        try { fs.unlinkSync(ownerFile); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            if (!lstatIfExists(lockDir)) return true;
            return false;
          }
          throw error;
        }
      }
      try { fs.rmdirSync(lockDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (!lstatIfExists(lockDir)) return true;
          return false;
        }
        throw error;
      }
      return true;
    } finally {
      reclaim.release();
    }
  }

  private withInboxLock<T>(file: string, operation: () => T): T {
    this.prepare(file);
    const lockDir = `${file}.lock`;
    const relative = path.relative(this.paths.root, lockDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`inbox lock escapes Agent root: ${lockDir}`);
    }
    const reclaimFile = `${lockDir}.reclaim`;
    const deadline = Date.now() + INBOX_LOCK_TIMEOUT_MS;
    const owner = newInboxLockOwner(this.inspect);
    let acquired = false;
    for (;;) {
      rejectSymlink(lockDir);
      rejectSymlink(reclaimFile);
      const reclaimStat = lstatIfExists(reclaimFile);
      if (reclaimStat) {
        if (!reclaimStat.isFile() || (typeof process.getuid === "function" && reclaimStat.uid !== process.getuid())) {
          throw new Error(`invalid inbox reclaim lock path: ${reclaimFile}`);
        }
        this.tryReclaimInboxLock(lockDir);
        if (lstatIfExists(reclaimFile)) {
          if (Date.now() >= deadline) throw new Error("Inbox 锁等待超时");
          sleepSync(50);
          continue;
        }
      }
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        const stat = fs.lstatSync(lockDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          throw new Error(`inbox lock is not an owned directory: ${lockDir}`);
        }
        const ownerFile = path.join(lockDir, INBOX_LOCK_OWNER_FILE);
        const fd = fs.openSync(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        if (lstatIfExists(reclaimFile)) {
          this.removeInboxLockIfOwned(lockDir, owner);
          throw Object.assign(new Error("Inbox lock 正在回收"), { code: "EEXIST" });
        }
        const current = this.readInboxLockOwner(lockDir);
        if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid) {
          throw new Error("Inbox lock owner 发布后不一致");
        }
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = lstatIfExists(lockDir);
        if (stat) {
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`invalid inbox lock path: ${lockDir}`);
          if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
            throw new Error(`inbox lock is not owned by current user: ${lockDir}`);
          }
          if (this.inboxLockState(lockDir) === "reclaimable" && this.tryReclaimInboxLock(lockDir)) continue;
        }
        if (Date.now() >= deadline) throw new Error("Inbox 锁等待超时");
        sleepSync(50);
      }
    }
    try {
      return operation();
    } finally {
      if (acquired) this.removeInboxLockIfOwned(lockDir, owner);
    }
  }

  /** Share the canonical Inbox/delivery-state transaction boundary with RuntimeHost. */
  withInboxTransaction<T>(operation: () => T): T {
    return this.withInboxLock(this.file("inbox"), operation);
  }

  private inboxState(): InboxStateFile {
    return normalizeInboxState(this.readJson<unknown>("inboxState", emptyInboxState()));
  }

  readFreshnessCursor<T>(target: string, generation = "external"): T | null {
    const state = this.readJson<{ version?: unknown; cursors?: unknown }>("freshnessState", { version: 1, cursors: {} });
    if (state.version !== 1 || !state.cursors || typeof state.cursors !== "object" || Array.isArray(state.cursors)) return null;
    const record = (state.cursors as Record<string, unknown>)[target];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const row = record as { generation?: unknown; cursor?: unknown };
    return row.generation === generation && row.cursor !== undefined ? row.cursor as T : null;
  }

  mergeFreshnessCursor<T>(target: string, cursor: T, merge: (previous: T | null, current: T) => T, generation = "external"): T {
    return this.mutateJson("freshnessState", { version: 1, cursors: {} as Record<string, { generation: string; cursor: T }> }, (state) => {
      if (state.version !== 1 || !state.cursors || typeof state.cursors !== "object" || Array.isArray(state.cursors)) {
        state.version = 1;
        state.cursors = {};
      }
      const previous = state.cursors[target];
      const next = merge(previous?.generation === generation ? previous.cursor : null, cursor);
      state.cursors[target] = { generation, cursor: next };
      return next;
    });
  }

  private normalizeInboxEnvelope(value: unknown, state: InboxStateFile): InboxEnvelope {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox envelope must be an object");
    const input = value as InboxEnvelope;
    const target = targetKeyOfInboxEnvelope(input);
    const current = state.targets[target] ?? { latest_received_seq: 0, model_seen_seq: 0 };
    const requested = validSequence(input.target_seq) ? input.target_seq : 0;
    const targetSeq = requested > current.latest_received_seq ? requested : current.latest_received_seq + 1;
    state.targets[target] = { ...current, latest_received_seq: targetSeq };
    if (typeof input.message_id === "string" && input.message_id) {
      state.messages[input.message_id] = { target, seq: targetSeq,
        ...(typeof input.kind === "string" && input.kind ? { kind: input.kind } : {}) };
      const messageIds = Object.keys(state.messages);
      for (const stale of messageIds.slice(0, Math.max(0, messageIds.length - 2_048))) delete state.messages[stale];
    }
    return { ...input, envelope_version: 2, target, target_seq: targetSeq };
  }

  private reconcileInboxRows(rows: InboxEnvelope[], state: InboxStateFile): InboxEnvelope[] {
    const targets = rows.map((row) => targetKeyOfInboxEnvelope(row));
    return rows.map((row, index) => {
      const target = targets[index]!;
      const existing = typeof row.message_id === "string" ? state.messages[row.message_id] : undefined;
      const current = state.targets[target] ?? { latest_received_seq: 0, model_seen_seq: 0 };
      const targetSeq = validSequence(row.target_seq) ? row.target_seq
        : existing?.target === target ? existing.seq : current.latest_received_seq + 1;
      current.latest_received_seq = Math.max(current.latest_received_seq, targetSeq);
      state.targets[target] = current;
      if (typeof row.message_id === "string" && row.message_id) state.messages[row.message_id] = { target, seq: targetSeq,
        ...(typeof row.kind === "string" && row.kind ? { kind: row.kind } : {}) };
      return { ...row, envelope_version: 2, target, target_seq: targetSeq };
    });
  }

  private appendInboxUnlocked(value: unknown): InboxEnvelope {
    const file = this.file("inbox");
    const state = this.inboxState();
    const envelope = this.normalizeInboxEnvelope(value, state);
    this.prepare(file);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, `${stringifyJson(envelope, false)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(file, 0o600);
    this.writeJson("inboxState", state);
    return envelope;
  }

  private replaceInboxUnlocked(rows: InboxEnvelope[]): void {
    const file = this.file("inbox");
    this.prepare(file);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const text = rows.length ? `${rows.map((row) => stringifyJson(row, false)).join("\n")}\n` : "";
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(file, 0o600);
  }

  private readText(file: string): string {
    validateExistingPath(file, this.boundary);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error(`state path is not an owned regular file: ${file}`);
      }
      return fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
  }

  readJson<T>(key: JsonStateKey, fallback: T): T {
    if (!JSON_KEYS.has(key)) throw new Error(`unknown JSON state key: ${key}`);
    const file = this.file(key);
    try { return JSON.parse(this.readText(file)) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  writeJson(key: JsonStateKey, value: unknown): void {
    if (!JSON_KEYS.has(key)) throw new Error(`unknown JSON state key: ${key}`);
    const file = this.file(key);
    this.prepare(file);
    const temporary = path.join(this.paths.root, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, `${stringifyJson(value, true)}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      rejectSymlink(file);
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  /** Serialize a read-modify-write transaction for one JSON state file across Host and Agent CLI processes. */
  mutateJson<T, R>(key: JsonStateKey, fallback: T, operation: (value: T) => R): R {
    const file = this.file(key);
    return this.withInboxLock(file, () => {
      const value = this.readJson<T>(key, fallback);
      const result = operation(value);
      this.writeJson(key, value);
      return result;
    });
  }

  appendNdjson(key: NdjsonStateKey, value: unknown): void {
    if (!NDJSON_KEYS.has(key)) throw new Error(`unknown NDJSON state key: ${key}`);
    const file = this.file(key);
    const append = (): void => {
      if (key === "inbox") {
        this.appendInboxUnlocked(value);
        return;
      }
      this.prepare(file);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, `${stringifyJson(value, false)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o600);
    };
    if (key === "inbox") this.withInboxLock(file, append);
    else append();
  }

  /**
   * Append one canonical Inbox envelope and return the exact normalized object
   * serialized to disk. Stable message_id dedupe and locator coherence share the
   * same lock as poll, so HostShell can deliver that very object without a
   * persistence/delivery split.
   */
  appendCanonicalInboxOnce(value: unknown): CanonicalInboxAppendResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox envelope must be an object");
    const input = value as InboxEnvelope;
    const messageId = input.message_id;
    if (typeof messageId !== "string" || !messageId) throw new Error("Inbox envelope requires message_id");
    const incomingTarget = targetKeyOfInboxEnvelope(input);
    const file = this.file("inbox");
    return this.withInboxLock(file, () => {
      const state = this.inboxState();
      const matching = this.readNdjson<InboxEnvelope>("inbox").filter((row) => row.message_id === messageId);
      if (matching.length > 1) throw new Error("Inbox duplicate message_id has multiple pending canonical rows");
      if (matching.length === 1) {
        const existing = matching[0]!;
        if (targetKeyOfInboxEnvelope(existing) !== incomingTarget) {
          throw new Error("Inbox duplicate message_id conflicts with its canonical target");
        }
        if (existing.target_seq !== undefined && !validSequence(existing.target_seq)) {
          throw new Error("Inbox duplicate message_id has a malformed canonical sequence");
        }
        const known = state.messages[messageId];
        if (known) {
          if (known.target !== incomingTarget) throw new Error("Inbox message state conflicts with its canonical target");
          if (validSequence(existing.target_seq) && existing.target_seq !== known.seq) {
            throw new Error("Inbox message state conflicts with its canonical sequence");
          }
          const targetState = state.targets[known.target];
          if (targetState && targetState.model_seen_seq >= known.seq) {
            throw new Error("Inbox pending row conflicts with consumed model-seen state");
          }
        }
        return { status: "duplicate_pending", envelope: existing };
      }
      const known = state.messages[messageId];
      if (known) {
        if (known.target !== incomingTarget) throw new Error("Inbox duplicate message_id conflicts with consumed canonical target");
        const targetState = state.targets[known.target];
        if (!targetState || targetState.model_seen_seq < known.seq) {
          throw new Error("Inbox state references a missing unconsumed canonical row");
        }
        return { status: "duplicate_consumed", envelope: null };
      }
      return { status: "appended", envelope: this.appendInboxUnlocked(input) };
    });
  }

  /** Append a canonical Inbox envelope once by stable message_id under the shared cross-process lock. */
  appendInboxOnce(value: unknown): boolean {
    return this.appendCanonicalInboxOnce(value).status === "appended";
  }

  /**
   * Resolve one Runtime delivery solely from canonical Inbox row/state. This is
   * the single replay resolver used for startup migration and every retry; it
   * never derives a DM/generic fallback from stale RuntimeInput text.
   */
  resolveInboxDeliverySource(messageId: string): InboxDeliverySourceResolution {
    if (!messageId) return { status: "missing", code: "canonical_inbox_row_missing" };
    return this.withInboxLock(this.file("inbox"), () => {
      let rows: InboxEnvelope[];
      try { rows = this.readNdjson<InboxEnvelope>("inbox"); }
      catch { return { status: "invalid", code: "canonical_inbox_malformed" }; }
      const matching = rows.filter((row) => row?.message_id === messageId);
      if (matching.length > 1) return { status: "invalid", code: "duplicate_message_id" };
      const state = this.inboxState();
      const known = state.messages[messageId];
      if (matching.length === 1) {
        const envelope = matching[0]!;
        let target: string;
        try { target = targetKeyOfInboxEnvelope(envelope); }
        catch { return { status: "invalid", code: "canonical_inbox_malformed" }; }
        if (envelope.target_seq !== undefined && !validSequence(envelope.target_seq)) {
          return { status: "invalid", code: "canonical_inbox_malformed" };
        }
        if (known) {
          const targetState = state.targets[known.target];
          if (known.target !== target || !validSequence(known.seq)
            || (validSequence(envelope.target_seq) && envelope.target_seq !== known.seq)
            || Boolean(targetState && targetState.model_seen_seq >= known.seq)) {
            return { status: "invalid", code: "inbox_state_conflict" };
          }
        }
        return { status: "pending", target, envelope };
      }
      if (!known) return { status: "missing", code: "canonical_inbox_row_missing" };
      if (!isCanonicalInboxTarget(known.target) || !validSequence(known.seq)) {
        return { status: "invalid", code: "inbox_state_conflict" };
      }
      const targetState = state.targets[known.target];
      if (targetState && targetState.model_seen_seq >= known.seq) return { status: "consumed", target: known.target };
      return { status: "missing", code: "canonical_inbox_row_missing" };
    });
  }

  /**
   * Re-arm only the durable deliveries proven to be the context-window incident.
   * The Inbox bytes are intentionally untouched. An optional synchronous commit
   * hook lets RuntimeHost swap its in-memory generation while this same lock is
   * still held. If the hook fails, the ledger is restored before the lock is
   * released. The callback also receives a guarded rollback for post-callback
   * commit failures before retry scheduling begins.
   */
  rearmContextOverflow(onCommit?: (messageIds: readonly string[], rollback: () => void) => void, expected?: {
    messageId?: string; deliveryId?: string; inputId?: string;
  }): ContextOverflowRearmResult {
    let lockActive = true;
    try { return this.withInboxTransaction(() => {
      let rows: InboxEnvelope[];
      try { rows = this.readNdjson<InboxEnvelope>("inbox"); }
      catch { throw new ContextOverflowRecoveryError("canonical_inbox_malformed", "canonical Inbox is malformed"); }
      if (rows.length === 0) throw new ContextOverflowRecoveryError("inbox_empty", "canonical Inbox backlog is empty");
      const messageIds = new Set<string>();
      for (const row of rows) {
        try { targetKeyOfInboxEnvelope(row); }
        catch { throw new ContextOverflowRecoveryError("canonical_inbox_malformed", "canonical Inbox contains a malformed row"); }
        if (typeof row.message_id !== "string" || !row.message_id) {
          throw new ContextOverflowRecoveryError("canonical_inbox_malformed", "canonical Inbox row has no message identity");
        }
        if (messageIds.has(row.message_id)) throw new ContextOverflowRecoveryError("duplicate_message_id", "canonical Inbox contains duplicate message identities");
        messageIds.add(row.message_id);
      }
      const ledger = this.readJson<RuntimeDeliveryStore>("runtimeDeliveries", { version: 1, records: [] });
      if (!Array.isArray(ledger.records)) throw new ContextOverflowRecoveryError("canonical_inbox_malformed", "Runtime delivery ledger is malformed");
      const ledgerRecords = ledger.records as unknown[];
      const matches = new Map<string, RuntimeDeliveryRecord>();
      const deliveryIds = new Set<string>();
      const inputIds = new Set<string>();
      for (const candidate of ledger.records) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const record = candidate as RuntimeDeliveryRecord;
        if (typeof record.messageId !== "string" || !messageIds.has(record.messageId)) continue;
        if (typeof record.deliveryId !== "string" || !record.deliveryId) throw new ContextOverflowRecoveryError("delivery_missing", "a matching Runtime delivery record has no delivery identity");
        if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
          throw new ContextOverflowRecoveryError("delivery_identity_invalid", "a matching Runtime delivery record has no Runtime input identity");
        }
        const input = record.input as Record<string, unknown>;
        if (typeof input.inputId !== "string" || !input.inputId.trim()
            || typeof input.deliveryId !== "string" || input.deliveryId !== record.deliveryId) {
          throw new ContextOverflowRecoveryError("delivery_identity_invalid", "a matching Runtime delivery record has malformed input identity");
        }
        if (matches.has(record.messageId)) throw new ContextOverflowRecoveryError("delivery_duplicate", "a canonical Inbox row maps to multiple delivery records");
        if (deliveryIds.has(record.deliveryId)) throw new ContextOverflowRecoveryError("delivery_duplicate", "matching Runtime delivery records share a delivery identity");
        if (inputIds.has(input.inputId)) throw new ContextOverflowRecoveryError("duplicate_input_id", "matching Runtime delivery records share an input identity");
        deliveryIds.add(record.deliveryId);
        inputIds.add(input.inputId);
        matches.set(record.messageId, record);
      }
      if (expected?.messageId && !messageIds.has(expected.messageId)) {
        throw new ContextOverflowRecoveryError("delivery_missing", "the expected context-overflow message is not in canonical Inbox");
      }
      if (expected?.messageId) {
        const expectedRecord = matches.get(expected.messageId);
        if (!expectedRecord || (expected.deliveryId && expectedRecord.deliveryId !== expected.deliveryId)
            || (expected.inputId && (expectedRecord.input as Record<string, unknown>).inputId !== expected.inputId)) {
          throw new ContextOverflowRecoveryError("delivery_identity_invalid", "the expected context-overflow delivery identity changed");
        }
      }
      for (const messageId of messageIds) {
        const record = matches.get(messageId);
        if (!record) throw new ContextOverflowRecoveryError("delivery_missing", "a canonical Inbox row has no Runtime delivery record");
        if (record.status !== "error" || record.retryable === true) {
          throw new ContextOverflowRecoveryError("delivery_not_terminal", "a canonical Inbox row is not backed by a non-retryable terminal Runtime error");
        }
        const reasonCategory = classifyStrictProviderError(buildStrictProviderErrorInput({
          reason: record.reason, errorCategory: record.errorCategory,
        }));
        if (record.retryable !== false || reasonCategory !== "context_window"
            || (record.errorCategory !== undefined && record.errorCategory !== "context_window")) {
          throw new ContextOverflowRecoveryError("delivery_not_context_window", "a Runtime delivery error is not classified as context_window");
        }
      }
      for (const candidate of ledgerRecords) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const record = candidate as RuntimeDeliveryRecord;
        if (typeof record.deliveryId === "string" && deliveryIds.has(record.deliveryId)
            && (typeof record.messageId !== "string" || !messageIds.has(record.messageId))) {
          throw new ContextOverflowRecoveryError("delivery_duplicate", "a matching delivery identity is also used by an unrelated Runtime delivery record");
        }
      }
      const updatedAt = new Date().toISOString();
      const records = ledgerRecords.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
        const record = candidate as RuntimeDeliveryRecord;
        if (typeof record.messageId !== "string" || !messageIds.has(record.messageId)) return candidate;
        return { ...record, status: "pending", retryable: true, updatedAt,
          reason: "context-window recovery rearmed the retained Inbox delivery" };
      });
      const committedLedger = { ...ledger, records };
      let restored = false;
      const restoreUnlocked = (): void => {
        if (restored) return;
        const current = this.readJson<RuntimeDeliveryStore>("runtimeDeliveries", { version: 1, records: [] });
        if (!Array.isArray(current.records)) throw new Error("Runtime delivery rollback found a malformed ledger");
        const originalMatching = ledgerRecords.filter((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
          const record = candidate as RuntimeDeliveryRecord;
          return typeof record.messageId === "string" && messageIds.has(record.messageId);
        });
        const originalDeliveryIds = new Set(originalMatching.flatMap((candidate) => {
          const deliveryId = (candidate as RuntimeDeliveryRecord).deliveryId;
          return typeof deliveryId === "string" ? [deliveryId] : [];
        }));
        const currentMatching = current.records.filter((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
          const record = candidate as RuntimeDeliveryRecord;
          return (typeof record.deliveryId === "string" && originalDeliveryIds.has(record.deliveryId))
            || (typeof record.messageId === "string" && messageIds.has(record.messageId));
        });
        const matchingRestored = currentMatching.length === originalMatching.length
          && currentMatching.every((candidate, index) => JSON.stringify(candidate) === JSON.stringify(originalMatching[index]));
        if (!matchingRestored) {
          const unrelated = current.records.filter((candidate) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const record = candidate as RuntimeDeliveryRecord;
            return !((typeof record.deliveryId === "string" && originalDeliveryIds.has(record.deliveryId))
              || (typeof record.messageId === "string" && messageIds.has(record.messageId)));
          });
          const restoredRecords = [...unrelated];
          for (const candidate of originalMatching) {
            const originalIndex = ledgerRecords.indexOf(candidate);
            restoredRecords.splice(Math.min(originalIndex, restoredRecords.length), 0, candidate);
          }
          this.writeJson("runtimeDeliveries", { ...current, records: restoredRecords });
        }
        restored = true;
      };
      const rollback = (): void => {
        if (lockActive) restoreUnlocked();
        else this.withInboxTransaction(restoreUnlocked);
      };
      try {
        this.writeJson("runtimeDeliveries", committedLedger);
        onCommit?.([...messageIds], rollback);
      } catch (error) {
        try { rollback(); }
        catch { throw new Error("context-window recovery ledger rollback failed"); }
        throw error;
      }
      return { rearmedCount: messageIds.size, remainingPendingCount: rows.length };
    }); } finally { lockActive = false; }
  }

  /**
   * Recoverably bridge an outbox wake into the canonical Inbox. A durable
   * Runtime ledger is authoritative after the Inbox has been drained, so a
   * post-delivery crash cannot re-append the same synthetic wake on restart.
   */
  prepareInboxDelivery(value: unknown): InboxDeliveryPreparation {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox envelope must be an object");
    const messageId = (value as Record<string, unknown>).message_id;
    if (typeof messageId !== "string" || !messageId) throw new Error("Inbox envelope requires message_id");
    targetKeyOfInboxEnvelope(value as InboxEnvelope);
    const file = this.file("inbox");
    return this.withInboxLock(file, () => {
      const ledger = this.readJson<RuntimeDeliveryStore>("runtimeDeliveries", { version: 1, records: [] });
      if (!Array.isArray(ledger.records)) throw new Error("runtime-deliveries.json records 必须是数组");
      const delivery = ledger.records.find((candidate) => candidate && typeof candidate === "object"
        && !Array.isArray(candidate) && (candidate as RuntimeDeliveryRecord).messageId === messageId) as RuntimeDeliveryRecord | undefined;
      if (delivery?.status === "consumed") return "consumed";
      if (["pending", "submitting", "accepted"].includes(String(delivery?.status || ""))) return "active";
      if (delivery?.status === "error") return "terminal_error";
      if (this.readNdjson<Record<string, unknown>>("inbox").some((row) => row.message_id === messageId)) return "present";
      this.appendInboxUnlocked(value);
      return "appended";
    });
  }

  readNdjson<T>(key: NdjsonStateKey): T[] {
    if (!NDJSON_KEYS.has(key)) throw new Error(`unknown NDJSON state key: ${key}`);
    const file = this.file(key);
    let text: string;
    try { text = this.readText(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as T; }
      catch (error) { throw new Error(`invalid NDJSON at ${file}:${index + 1}: ${(error as Error).message}`); }
    });
  }

  /**
   * Atomically parse and drain the current Inbox batch relative to all
   * AgentStateStore Inbox appenders. Parsing completes before truncation, so a
   * malformed batch is left byte-for-byte intact. An appender arriving while
   * this transaction is active waits and becomes part of the next batch.
   */
  pollInbox<T extends InboxEnvelope = InboxEnvelope>(options: InboxPollOptions = {}): InboxPollResult<T> {
    if (options.target && !isCanonicalInboxTarget(options.target)) {
      throw new Error(`Invalid canonical Inbox poll target ${JSON.stringify(options.target)}`);
    }
    const file = this.file("inbox");
    return this.withInboxLock(file, () => {
      let rawRows: T[];
      try { rawRows = this.readNdjson<T>("inbox"); }
      catch (error) { throw error; }
      options.afterRead?.();
      const state = this.inboxState();
      const rows = this.reconcileInboxRows(rawRows, state) as T[];
      const limit = options.limit === undefined ? 100 : options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("inbox poll --limit 必须是 1..100 的整数");
      const envelopes: T[] = [];
      const remaining: T[] = [];
      for (const row of rows) {
        const selectedTarget = targetKeyOfInboxEnvelope(row);
        if (envelopes.length < limit && (!options.target || options.target === selectedTarget)) envelopes.push(row);
        else remaining.push(row);
      }
      const pendingCount = remaining.reduce((count, row) => {
        if (!options.target) return count + 1;
        const rowTarget = targetKeyOfInboxEnvelope(row);
        return count + (rowTarget === options.target ? 1 : 0);
      }, 0);
      if (!envelopes.length) return { envelopes, consumedDeliveryIds: [], seenThroughSeq: null, pendingCount };
      const messageIds = new Set(envelopes.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const messageId = (row as Record<string, unknown>).message_id;
        return typeof messageId === "string" && messageId ? [messageId] : [];
      }));
      const consumedDeliveryIds: string[] = [];
      if (messageIds.size) {
        const deliveries = this.readJson<RuntimeDeliveryStore>("runtimeDeliveries", { version: 1, records: [] });
        if (!Array.isArray(deliveries.records)) throw new Error("runtime-deliveries.json records 必须是数组");
        let changed = false;
        const updatedAt = new Date((options.now ?? Date.now)()).toISOString();
        const records = deliveries.records.map((rawRecord) => {
          if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) return rawRecord;
          const record = rawRecord as RuntimeDeliveryRecord;
          if (typeof record.messageId !== "string" || !messageIds.has(record.messageId) || record.status === "consumed") return rawRecord;
          changed = true;
          if (typeof (record as Record<string, unknown>).deliveryId === "string") consumedDeliveryIds.push((record as Record<string, unknown>).deliveryId as string);
          return { ...record, status: "consumed", updatedAt };
        });
        if (changed) this.writeJson("runtimeDeliveries", { ...deliveries, records });
      }
      let seenThroughSeq: number | null = null;
      for (const envelope of envelopes) {
        const target = targetKeyOfInboxEnvelope(envelope);
        const targetSeq = Number(envelope.target_seq);
        const targetState = state.targets[target] ?? { latest_received_seq: targetSeq, model_seen_seq: 0 };
        if (validSequence(targetSeq)) {
          targetState.latest_received_seq = Math.max(targetState.latest_received_seq, targetSeq);
          targetState.model_seen_seq = Math.max(targetState.model_seen_seq, targetSeq);
          seenThroughSeq = seenThroughSeq === null ? targetSeq : Math.max(seenThroughSeq, targetSeq);
        }
        state.targets[target] = targetState;
      }
      this.replaceInboxUnlocked(remaining);
      this.writeJson("inboxState", state);
      return { envelopes, consumedDeliveryIds, seenThroughSeq, pendingCount };
    });
  }

  drainInbox<T extends InboxEnvelope = InboxEnvelope>(hooks: InboxDrainHooks = {}): T[] {
    return this.pollInbox<T>(hooks).envelopes;
  }

  resolveInboxMessageTarget(messageId: string): string | null {
    return this.withInboxLock(this.file("inbox"), () => {
      const state = this.inboxState();
      const known = state.messages[messageId];
      if (known) return targetKeyOfInboxEnvelope({ message_id: messageId, target: known.target,
        ...(known.kind ? { kind: known.kind } : {}) });
      const row = this.readNdjson<InboxEnvelope>("inbox").find((candidate) => candidate.message_id === messageId);
      return row ? targetKeyOfInboxEnvelope(row) : null;
    });
  }

  listInboxDrafts(): InboxDraft[] {
    return this.withInboxLock(this.file("inbox"), () => Object.values(this.inboxState().drafts)
      .filter((draft) => draft.status === "held" || draft.status === "sending")
      .sort((left, right) => left.created_at.localeCompare(right.created_at)));
  }

  readInboxDraft(draftId: string): InboxDraft | null {
    return this.withInboxLock(this.file("inbox"), () => this.inboxState().drafts[draftId] ?? null);
  }

  setInboxDraftStatus(draftId: string, status: "sent" | "abandoned", now = Date.now()): InboxDraft {
    return this.withInboxLock(this.file("inbox"), () => {
      const state = this.inboxState();
      const draft = state.drafts[draftId];
      if (!draft) throw new Error(`draft 不存在：${draftId}`);
      if (draft.status === "sending") throw new Error(`draft ${draftId} 正在发送，too late to abandon；可重试 send 以同一幂等键恢复`);
      if (draft.status !== "held") throw new Error(`draft ${draftId} 已是 ${draft.status}`);
      const updated = { ...draft, status, updated_at: new Date(now).toISOString() };
      state.drafts[draftId] = updated;
      this.writeJson("inboxState", state);
      return updated;
    });
  }

  inboxTargetIsFresh(target: string): boolean {
    return this.withInboxLock(this.file("inbox"), () => {
      const state = this.inboxState();
      const targetState = state.targets[target] ?? { latest_received_seq: 0, model_seen_seq: 0 };
      return targetState.latest_received_seq <= targetState.model_seen_seq;
    });
  }

  withFreshnessGate<T>(input: { target: string; argv: readonly string[]; now?: number;
    commitDraftId?: string; providerSucceeded?(result: T): boolean }, perform: (intentId: string) => T): FreshnessGateResult<T> {
    const file = this.file("inbox");
    type Preflight = Extract<FreshnessGateResult<T>, { status: "held" }>
      | { status: "ready"; intentId: string; commitDraftId?: string };
    const preflight: Preflight = this.withInboxLock(file, (): Preflight => {
      const state = this.inboxState();
      const rows = this.reconcileInboxRows(this.readNdjson<InboxEnvelope>("inbox"), state);
      const pendingLatest = rows.filter((row) => row.target === input.target)
        .reduce((latest, row) => validSequence(row.target_seq) ? Math.max(latest, row.target_seq) : latest, 0);
      const target = state.targets[input.target] ?? { latest_received_seq: pendingLatest, model_seen_seq: 0 };
      target.latest_received_seq = Math.max(target.latest_received_seq, pendingLatest);
      state.targets[input.target] = target;
      const draftFingerprint = crypto.createHash("sha256").update(JSON.stringify([input.target, input.argv])).digest("hex");
      let commitDraft: InboxDraft | undefined;
      if (input.commitDraftId) {
        if (!input.providerSucceeded) throw new Error("commitDraftId requires providerSucceeded");
        const draft = state.drafts[input.commitDraftId];
        if (!draft || (draft.status !== "held" && draft.status !== "sending") || draft.target !== input.target
            || JSON.stringify(draft.argv) !== JSON.stringify(input.argv)) {
          throw new Error(`held/sending draft 与 freshness intent 不匹配：${input.commitDraftId}`);
        }
        commitDraft = draft;
        if (draft.status === "sending") {
          const intentId = draft.intent_id!;
          const existingIntent = state.intents[intentId];
          state.intents[intentId] = existingIntent ?? {
            intent_id: intentId, target: input.target, argv: [...input.argv],
            latest_received_seq: draft.intent_model_seen_seq!, model_seen_seq: draft.intent_model_seen_seq!,
            committed_at: draft.sending_at!, draft_id: draft.draft_id,
          };
          this.writeJson("inboxState", state);
          return { status: "ready", intentId, commitDraftId: draft.draft_id };
        }
      }
      if (target.latest_received_seq > target.model_seen_seq) {
        let draftId = commitDraft?.draft_id ?? `draft_${draftFingerprint.slice(0, 24)}`;
        const at = new Date(input.now ?? Date.now()).toISOString();
        let existing = state.drafts[draftId];
        if (!commitDraft && existing && existing.status !== "held") {
          const boundaryFingerprint = crypto.createHash("sha256")
            .update(JSON.stringify([input.target, input.argv, target.latest_received_seq])).digest("hex");
          draftId = `draft_${boundaryFingerprint.slice(0, 24)}`;
          existing = state.drafts[draftId];
        }
        const draft: InboxDraft = existing?.status === "held" ? {
          ...existing, held_at_seq: target.latest_received_seq, updated_at: at,
        } : {
          draft_id: draftId, target: input.target, argv: [...input.argv], status: "held",
          held_at_seq: target.latest_received_seq, created_at: at, updated_at: at,
        };
        state.drafts[draftId] = draft;
        this.writeJson("inboxState", state);
        return { status: "held", target: input.target, latest_received_seq: target.latest_received_seq,
          model_seen_seq: target.model_seen_seq, draft };
      }
      const fingerprint = crypto.createHash("sha256")
        .update(JSON.stringify([input.target, input.argv, target.model_seen_seq])).digest("hex");
      const intentId = `larkin-${fingerprint.slice(0, 32)}`;
      const commitDraftId = commitDraft?.draft_id;
      const committedAt = new Date(input.now ?? Date.now()).toISOString();
      if (commitDraft) {
        state.drafts[commitDraft.draft_id] = {
          ...commitDraft, status: "sending", intent_id: intentId,
          intent_model_seen_seq: target.model_seen_seq, sending_at: committedAt, updated_at: committedAt,
        };
      }
      const existingIntent = state.intents[intentId];
      state.intents[intentId] = existingIntent ? {
        ...existingIntent, ...(commitDraftId ? { draft_id: commitDraftId } : {}),
      } : {
        intent_id: intentId,
        target: input.target,
        argv: [...input.argv],
        latest_received_seq: target.latest_received_seq,
        model_seen_seq: target.model_seen_seq,
        committed_at: committedAt,
        ...(commitDraftId ? { draft_id: commitDraftId } : {}),
      };
      const intentIds = Object.keys(state.intents)
        .sort((left, right) => state.intents[left].committed_at.localeCompare(state.intents[right].committed_at));
      for (const stale of intentIds.slice(0, Math.max(0, intentIds.length - 2_048))) delete state.intents[stale];
      this.writeJson("inboxState", state);
      return { status: "ready" as const, intentId, commitDraftId };
    });
    if (preflight.status === "held") return preflight;
    // Provider/network work starts only after the durable intent commit has
    // released the Inbox lock. That commit is the local receive boundary.
    const finalizeDraft = (succeeded: boolean): void => {
      if (!preflight.commitDraftId) return;
      this.withInboxLock(file, () => {
        const state = this.inboxState();
        const draft = state.drafts[preflight.commitDraftId!];
        if (succeeded && draft?.status === "sent" && draft.intent_id === preflight.intentId) return;
        if (!draft || draft.status !== "sending" || draft.intent_id !== preflight.intentId
            || draft.target !== input.target || JSON.stringify(draft.argv) !== JSON.stringify(input.argv)) {
          throw new Error(`held draft finalize 状态不一致：${preflight.commitDraftId}`);
        }
        const updatedAt = new Date(input.now ?? Date.now()).toISOString();
        if (succeeded) state.drafts[draft.draft_id] = { ...draft, status: "sent", updated_at: updatedAt };
        else {
          const latest = state.targets[draft.target]?.latest_received_seq ?? draft.held_at_seq;
          const { intent_id: _intentId, intent_model_seen_seq: _boundary, sending_at: _sendingAt, ...retryable } = draft;
          state.drafts[draft.draft_id] = {
            ...retryable, status: "held", held_at_seq: Math.max(draft.held_at_seq, latest), updated_at: updatedAt,
          };
        }
        this.writeJson("inboxState", state);
      });
    };
    let result: T;
    try {
      result = perform(preflight.intentId);
    } catch (error) {
      finalizeDraft(false);
      throw error;
    }
    finalizeDraft(Boolean(input.providerSucceeded?.(result)));
    return { status: "ready", target: input.target, intentId: preflight.intentId, result };
  }

  /**
   * Legacy explicit clear operation. New Inbox consumers must use pollInbox so
   * a concurrent cooperating append cannot be truncated.
   */
  clearNdjson(key: NdjsonStateKey): void {
    if (!NDJSON_KEYS.has(key)) throw new Error(`unknown NDJSON state key: ${key}`);
    const file = this.file(key);
    validateExistingPath(file, this.boundary);
    const existing = lstatIfExists(file);
    if (!existing) return;
    this.prepare(file);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error(`state path is not an owned regular file: ${file}`);
      }
      fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
    fs.chmodSync(file, 0o600);
  }
}

export function createAgentStateStore(
  root: string, agentId: string, dependencies: AgentStateStoreDependencies = {},
): AgentStateStore {
  return new AgentStateStore(TargetRootLayout.fromConfigDir(root), agentId, dependencies);
}
