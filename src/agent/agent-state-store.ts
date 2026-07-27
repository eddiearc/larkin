import * as fs from "node:fs";
import * as path from "node:path";
import { TargetRootLayout, type AgentStatePaths } from "../platform/root-layout.js";

export type JsonStateKey = "agentState" | "status" | "map" | "replyctx" | "botIdentity" |
  "senderProfiles" | "readReceipts" | "pendingReact" | "runtimeDeliveries" | "reminders" | "interactions";
export type NdjsonStateKey = "conversation" | "inbox";

const JSON_KEYS: ReadonlySet<string> = new Set([
  "agentState", "status", "map", "replyctx", "botIdentity", "senderProfiles", "readReceipts", "pendingReact", "runtimeDeliveries", "reminders", "interactions",
]);
const NDJSON_KEYS: ReadonlySet<string> = new Set(["conversation", "inbox"]);
const INBOX_LOCK_TIMEOUT_MS = 2_000;
const INBOX_STALE_LOCK_MS = 10_000;

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

interface RuntimeDeliveryRecord extends Record<string, unknown> {
  messageId?: unknown;
  status?: unknown;
}

interface RuntimeDeliveryStore extends Record<string, unknown> {
  version?: unknown;
  records?: unknown;
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

  private withInboxLock<T>(file: string, operation: () => T): T {
    this.prepare(file);
    const lockDir = `${file}.lock`;
    const relative = path.relative(this.paths.root, lockDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`inbox lock escapes Agent root: ${lockDir}`);
    }
    const deadline = Date.now() + INBOX_LOCK_TIMEOUT_MS;
    for (;;) {
      rejectSymlink(lockDir);
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        const stat = fs.lstatSync(lockDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          throw new Error(`inbox lock is not an owned directory: ${lockDir}`);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = fs.lstatSync(lockDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`invalid inbox lock path: ${lockDir}`);
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          throw new Error(`inbox lock is not owned by current user: ${lockDir}`);
        }
        if (Date.now() - stat.mtimeMs > INBOX_STALE_LOCK_MS) {
          try { fs.rmdirSync(lockDir); } catch (reclaimError) {
            if (!(["ENOENT", "ENOTEMPTY"] as Array<string | undefined>).includes((reclaimError as NodeJS.ErrnoException).code)) throw reclaimError;
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Inbox 锁等待超时");
        sleepSync(15);
      }
    }
    try {
      return operation();
    } finally {
      try { fs.rmdirSync(lockDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  /** Share the canonical Inbox/delivery-state transaction boundary with RuntimeHost. */
  withInboxTransaction<T>(operation: () => T): T {
    return this.withInboxLock(this.file("inbox"), operation);
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
      this.prepare(file);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, `${stringifyJson(value, false)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o600);
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
      this.prepare(file);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, `${stringifyJson(value, false)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o600);
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
  drainInbox<T>(hooks: InboxDrainHooks = {}): T[] {
    const file = this.file("inbox");
    return this.withInboxLock(file, () => {
      let rows: T[];
      try { rows = this.readNdjson<T>("inbox"); }
      catch (error) { throw error; }
      hooks.afterRead?.();
      if (!rows.length) return rows;
      const messageIds = new Set(rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const messageId = (row as Record<string, unknown>).message_id;
        return typeof messageId === "string" && messageId ? [messageId] : [];
      }));
      if (messageIds.size) {
        const deliveries = this.readJson<RuntimeDeliveryStore>("runtimeDeliveries", { version: 1, records: [] });
        if (!Array.isArray(deliveries.records)) throw new Error("runtime-deliveries.json records 必须是数组");
        let changed = false;
        const updatedAt = new Date((hooks.now ?? Date.now)()).toISOString();
        const records = deliveries.records.map((rawRecord) => {
          if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) return rawRecord;
          const record = rawRecord as RuntimeDeliveryRecord;
          if (typeof record.messageId !== "string" || !messageIds.has(record.messageId) || record.status === "consumed") return rawRecord;
          changed = true;
          return { ...record, status: "consumed", updatedAt };
        });
        if (changed) this.writeJson("runtimeDeliveries", { ...deliveries, records });
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          throw new Error(`state path is not an owned regular file: ${file}`);
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o600);
      return rows;
    });
  }

  /**
   * Legacy explicit clear operation. New Inbox consumers must use drainInbox so
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
