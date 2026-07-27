import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { TargetRootLayout, type AgentStatePaths } from "../platform/root-layout.js";
import { inspectProcess } from "../platform/process-state.js";
import { targetKeyOfInboxEnvelope, type InboxEnvelope } from "./inbox-projection.js";

export type JsonStateKey = "agentState" | "status" | "map" | "replyctx" | "botIdentity" |
  "senderProfiles" | "readReceipts" | "pendingReact" | "runtimeDeliveries" | "inboxState" | "reminders" | "interactions";
export type NdjsonStateKey = "conversation" | "inbox";

const JSON_KEYS: ReadonlySet<string> = new Set([
  "agentState", "status", "map", "replyctx", "botIdentity", "senderProfiles", "readReceipts", "pendingReact", "runtimeDeliveries", "inboxState", "reminders", "interactions",
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
}

interface InboxTargetState {
  latest_received_seq: number;
  model_seen_seq: number;
}

export interface InboxDraft {
  draft_id: string;
  target: string;
  argv: string[];
  status: "held" | "sent" | "abandoned";
  held_at_seq: number;
  created_at: string;
  updated_at: string;
}

interface InboxStateFile {
  version: 2;
  targets: Record<string, InboxTargetState>;
  messages: Record<string, { target: string; seq: number }>;
  drafts: Record<string, InboxDraft>;
}

export type FreshnessGateResult<T> =
  | { status: "held"; target: string; latest_received_seq: number; model_seen_seq: number; draft: InboxDraft }
  | { status: "ready"; target: string; intentId: string; result: T };

function emptyInboxState(): InboxStateFile {
  return { version: 2, targets: {}, messages: {}, drafts: {} };
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
      const row = candidate as { target?: unknown; seq?: unknown };
      if (typeof row.target === "string" && row.target && validSequence(row.seq)) state.messages[messageId] = { target: row.target, seq: row.seq };
    }
  }
  if (raw.drafts && typeof raw.drafts === "object" && !Array.isArray(raw.drafts)) {
    for (const [draftId, candidate] of Object.entries(raw.drafts)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const draft = candidate as InboxDraft;
      if (draft.draft_id === draftId && typeof draft.target === "string" && Array.isArray(draft.argv)
        && draft.argv.every((argument) => typeof argument === "string") && ["held", "sent", "abandoned"].includes(draft.status)) {
        state.drafts[draftId] = { ...draft, argv: [...draft.argv] };
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

function newInboxLockOwner(): InboxLockOwner {
  const inspected = inspectProcess(process.pid);
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

export class AgentStateStore {
  readonly paths: AgentStatePaths;
  private readonly boundary: string;

  constructor(layout: TargetRootLayout, agentId: string) {
    this.paths = layout.agentStatePaths(agentId);
    this.boundary = path.join(layout.root, "state");
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
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
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
      const age = Date.now() - fs.lstatSync(lockDir).mtimeMs;
      return age >= INBOX_MALFORMED_LOCK_GRACE_MS ? "reclaimable" : "unknown";
    }
    const inspected = inspectProcess(owner.pid);
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
    const reclaimDir = `${lockDir}.reclaim`;
    try { fs.mkdirSync(reclaimDir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
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
      const entries = fs.readdirSync(lockDir);
      if (entries.some((entry) => entry !== INBOX_LOCK_OWNER_FILE)) {
        throw new Error(`Inbox lock 包含未知内容，拒绝回收：${lockDir}`);
      }
      if (entries.includes(INBOX_LOCK_OWNER_FILE)) {
        const ownerStat = fs.lstatSync(path.join(lockDir, INBOX_LOCK_OWNER_FILE));
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new Error(`Inbox lock owner 路径无效：${lockDir}`);
        fs.unlinkSync(path.join(lockDir, INBOX_LOCK_OWNER_FILE));
      }
      fs.rmdirSync(lockDir);
      return true;
    } finally {
      try { fs.rmdirSync(reclaimDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private withInboxLock<T>(file: string, operation: () => T): T {
    this.prepare(file);
    const lockDir = `${file}.lock`;
    const relative = path.relative(this.paths.root, lockDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`inbox lock escapes Agent root: ${lockDir}`);
    }
    const reclaimDir = `${lockDir}.reclaim`;
    const deadline = Date.now() + INBOX_LOCK_TIMEOUT_MS;
    const owner = newInboxLockOwner();
    let acquired = false;
    for (;;) {
      rejectSymlink(lockDir);
      rejectSymlink(reclaimDir);
      try {
        if (lstatIfExists(reclaimDir)) throw Object.assign(new Error("Inbox lock 正在回收"), { code: "EEXIST" });
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
        if (lstatIfExists(reclaimDir)) {
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

  private normalizeInboxEnvelope(value: unknown, state: InboxStateFile): InboxEnvelope {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox envelope must be an object");
    const input = value as InboxEnvelope;
    const target = typeof input.target === "string" && input.target ? input.target : targetKeyOfInboxEnvelope(input);
    const current = state.targets[target] ?? { latest_received_seq: 0, model_seen_seq: 0 };
    const requested = validSequence(input.target_seq) ? input.target_seq : 0;
    const targetSeq = requested > current.latest_received_seq ? requested : current.latest_received_seq + 1;
    state.targets[target] = { ...current, latest_received_seq: targetSeq };
    if (typeof input.message_id === "string" && input.message_id) {
      state.messages[input.message_id] = { target, seq: targetSeq };
      const messageIds = Object.keys(state.messages);
      for (const stale of messageIds.slice(0, Math.max(0, messageIds.length - 2_048))) delete state.messages[stale];
    }
    return { ...input, envelope_version: 2, target, target_seq: targetSeq };
  }

  private reconcileInboxRows(rows: InboxEnvelope[], state: InboxStateFile): InboxEnvelope[] {
    return rows.map((row) => {
      const target = typeof row.target === "string" && row.target ? row.target : targetKeyOfInboxEnvelope(row);
      const existing = typeof row.message_id === "string" ? state.messages[row.message_id] : undefined;
      const current = state.targets[target] ?? { latest_received_seq: 0, model_seen_seq: 0 };
      const targetSeq = validSequence(row.target_seq) ? row.target_seq
        : existing?.target === target ? existing.seq : current.latest_received_seq + 1;
      current.latest_received_seq = Math.max(current.latest_received_seq, targetSeq);
      state.targets[target] = current;
      if (typeof row.message_id === "string" && row.message_id) state.messages[row.message_id] = { target, seq: targetSeq };
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

  /** Append a canonical Inbox envelope once by stable message_id under the shared cross-process lock. */
  appendInboxOnce(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox envelope must be an object");
    const messageId = (value as Record<string, unknown>).message_id;
    if (typeof messageId !== "string" || !messageId) throw new Error("Inbox envelope requires message_id");
    const file = this.file("inbox");
    return this.withInboxLock(file, () => {
      if (this.readNdjson<Record<string, unknown>>("inbox").some((row) => row.message_id === messageId)) return false;
      this.appendInboxUnlocked(value);
      return true;
    });
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
        const selectedTarget = typeof row.target === "string" ? row.target : targetKeyOfInboxEnvelope(row);
        if (envelopes.length < limit && (!options.target || options.target === selectedTarget)) envelopes.push(row);
        else remaining.push(row);
      }
      if (!envelopes.length) return { envelopes, consumedDeliveryIds: [], seenThroughSeq: null };
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
        const target = String(envelope.target || targetKeyOfInboxEnvelope(envelope));
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
      return { envelopes, consumedDeliveryIds, seenThroughSeq };
    });
  }

  drainInbox<T extends InboxEnvelope = InboxEnvelope>(hooks: InboxDrainHooks = {}): T[] {
    return this.pollInbox<T>(hooks).envelopes;
  }

  resolveInboxMessageTarget(messageId: string): string | null {
    return this.withInboxLock(this.file("inbox"), () => {
      const state = this.inboxState();
      const known = state.messages[messageId]?.target;
      if (known) return known;
      const row = this.readNdjson<InboxEnvelope>("inbox").find((candidate) => candidate.message_id === messageId);
      return row ? (typeof row.target === "string" ? row.target : targetKeyOfInboxEnvelope(row)) : null;
    });
  }

  listInboxDrafts(): InboxDraft[] {
    return this.withInboxLock(this.file("inbox"), () => Object.values(this.inboxState().drafts)
      .filter((draft) => draft.status === "held")
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
    return this.withInboxLock(file, () => {
      const state = this.inboxState();
      const rows = this.reconcileInboxRows(this.readNdjson<InboxEnvelope>("inbox"), state);
      const pendingLatest = rows.filter((row) => row.target === input.target)
        .reduce((latest, row) => validSequence(row.target_seq) ? Math.max(latest, row.target_seq) : latest, 0);
      const target = state.targets[input.target] ?? { latest_received_seq: pendingLatest, model_seen_seq: 0 };
      target.latest_received_seq = Math.max(target.latest_received_seq, pendingLatest);
      state.targets[input.target] = target;
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify([input.target, input.argv])).digest("hex");
      const intentId = `larkin-${fingerprint.slice(0, 32)}`;
      if (target.latest_received_seq > target.model_seen_seq) {
        const draftId = `draft_${fingerprint.slice(0, 24)}`;
        const at = new Date(input.now ?? Date.now()).toISOString();
        const existing = state.drafts[draftId];
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
      let commitDraft: InboxDraft | undefined;
      if (input.commitDraftId) {
        if (!input.providerSucceeded) throw new Error("commitDraftId requires providerSucceeded");
        const draft = state.drafts[input.commitDraftId];
        if (!draft || draft.status !== "held" || draft.target !== input.target
            || JSON.stringify(draft.argv) !== JSON.stringify(input.argv)) {
          throw new Error(`held draft 与 freshness intent 不匹配：${input.commitDraftId}`);
        }
        commitDraft = draft;
      }
      this.writeJson("inboxState", state);
      const result = perform(intentId);
      if (commitDraft && input.providerSucceeded?.(result)) {
        const at = new Date(input.now ?? Date.now()).toISOString();
        state.drafts[commitDraft.draft_id] = { ...commitDraft, status: "sent", updated_at: at };
        this.writeJson("inboxState", state);
      }
      return { status: "ready", target: input.target, intentId, result };
    });
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

export function createAgentStateStore(root: string, agentId: string): AgentStateStore {
  return new AgentStateStore(TargetRootLayout.fromConfigDir(root), agentId);
}
