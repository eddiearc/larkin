import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PI_CONTEXT_WINDOW = 272_000;
export const COMPACTION_RESERVE_TOKENS = 40_800;
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const PI_COMPACTION_THRESHOLD = PI_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS;
export const PI_COMPACTION_RECOVERY_VERSION = 1;
export const PI_COMPACTION_RECOVERY_FILE = "piCompactionRecovery.json";

const AGENT_ID = /^cli_[A-Za-z0-9]+$/;
const REQUIRED_PI_EVENTS = ["compaction_start", "compaction_end", "agent_end", "agent_settled"] as const;
const TERMINAL_STATES = new Set<PiCompactionState>(["closed", "fallback_committed"]);
const ALLOWED_TRANSITIONS: Record<PiCompactionState, readonly PiCompactionState[]> = {
  eligible: ["native_compacting", "native_retry_owned", "settled_for_manual"],
  native_compacting: ["native_retry_owned", "native_succeeded", "native_failed"],
  native_retry_owned: ["native_compacting", "native_succeeded", "native_failed"],
  native_succeeded: ["closed"],
  native_failed: ["fallback_required", "fallback_committed"],
  settled_for_manual: ["manual_sent"],
  manual_sent: ["manual_succeeded", "manual_failed", "manual_ambiguous"],
  manual_succeeded: ["retrying", "second_overflow"],
  manual_failed: ["fallback_required", "fallback_committed"],
  manual_ambiguous: ["fallback_required", "fallback_committed"],
  retrying: ["second_overflow", "closed"],
  second_overflow: ["fallback_required", "fallback_committed"],
  fallback_required: ["fallback_committed"],
  fallback_committed: ["closed"],
  closed: [],
};

export type PiCompactionState =
  | "eligible" | "native_compacting" | "native_retry_owned" | "native_succeeded" | "native_failed"
  | "settled_for_manual" | "manual_sent" | "manual_succeeded" | "manual_failed" | "manual_ambiguous"
  | "retrying" | "second_overflow" | "fallback_required" | "fallback_committed" | "closed";

export interface PiCompactionRecord {
  key: string;
  messageId: string;
  deliveryId: string;
  inputId: string;
  sessionGeneration: number;
  state: PiCompactionState;
  manualAttempt: number;
  compactSentAt: string | null;
  compactDeadlineAt: string | null;
  compactFinishedAt: string | null;
  retrySubmittedAt: string | null;
  fallbackReason: string | null;
  compactResponseReceived?: boolean;
  compactionLifecycleSucceeded?: boolean;
  updatedAt: string;
}

interface PiCompactionFile {
  version: 1;
  records: PiCompactionRecord[];
}

export interface EffectivePiSettings {
  contextWindow?: number;
  model?: { contextWindow?: number } | null;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
}

function requireFiniteBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function isPiNativeCompactionRequired(contextTokens: number): boolean {
  return Number.isFinite(contextTokens) && contextTokens > PI_COMPACTION_THRESHOLD;
}

export function assertEffectivePiCompactionSettings(settings: EffectivePiSettings): void {
  const contextWindow = settings.contextWindow ?? settings.model?.contextWindow;
  if (contextWindow !== PI_CONTEXT_WINDOW) throw new Error(`Pi effective context window must be exactly ${PI_CONTEXT_WINDOW}`);
  if (settings.compaction?.enabled !== true) throw new Error("Pi native compaction must be enabled");
  if (settings.compaction.reserveTokens !== COMPACTION_RESERVE_TOKENS) {
    throw new Error(`Pi reserveTokens must be exactly ${COMPACTION_RESERVE_TOKENS}`);
  }
  if (settings.compaction.keepRecentTokens !== COMPACTION_KEEP_RECENT_TOKENS) {
    throw new Error(`Pi keepRecentTokens must be exactly ${COMPACTION_KEEP_RECENT_TOKENS}`);
  }
}

export function hasProjectPiCompactionOverride(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const value = settings as Record<string, unknown>;
  if (Object.hasOwn(value, "contextWindow") || Object.hasOwn(value, "contextTokens")
      || Object.hasOwn(value, "reserveTokens") || Object.hasOwn(value, "keepRecentTokens")) return true;
  const compaction = value.compaction;
  return Boolean(compaction && typeof compaction === "object" && !Array.isArray(compaction)
    && ["enabled", "reserveTokens", "keepRecentTokens"].some((key) => Object.hasOwn(compaction, key)));
}

function assertOwnedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Pi Agent directory is unsafe: ${directory}`);
  if (process.platform !== "win32" && ((typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700)) throw new Error("Pi Agent directory must be owner-only 0700");
}

function ensureDirectory(directory: string): void {
  try {
    const existing = fs.lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`unsafe Pi Agent directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
  assertOwnedDirectory(directory);
}

function ensureDirectoryChain(directory: string): void {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      // macOS exposes /tmp and /var as stable system aliases; all deeper
      // Larkin-controlled ancestors remain strictly no-symlink.
      const knownSystemSymlink = current === "/tmp" || current === "/var" || current === "/private/tmp" || current === "/private/var";
      const systemAlias = knownSystemSymlink
        || current === "/var/folders" || /^\/var\/folders\/[^/]+$/.test(current)
        || current === "/private/var/folders" || /^\/private\/var\/folders\/[^/]+$/.test(current);
      if ((!knownSystemSymlink && stat.isSymbolicLink()) || (!systemAlias && !stat.isDirectory())) {
        throw new Error(`unsafe Pi Agent ancestor: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`unsafe Pi Agent ancestor: ${current}`);
    }
  }
}

export function ensureOwnedPiAgentDirectory(root: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error("invalid Pi Agent ID");
  ensureDirectoryChain(root);
  const resolvedRoot = path.resolve(root);
  ensureDirectory(resolvedRoot);
  const parent = path.join(resolvedRoot, "pi-agents");
  ensureDirectory(parent);
  const directory = path.join(parent, agentId);
  ensureDirectory(directory);
  return directory;
}

export function ownedPiSettings(directory: string): string {
  return path.join(directory, "settings.json");
}

export function prepareOwnedPiDirectory(directory: string): string {
  ensureDirectoryChain(path.dirname(directory));
  ensureDirectory(path.dirname(directory));
  ensureDirectory(directory);
  writeOwnedPiSettings(directory);
  return directory;
}

export function writeOwnedPiSettings(directory: string): void {
  ensureDirectoryChain(path.dirname(directory));
  ensureDirectory(directory);
  const file = ownedPiSettings(directory);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Pi owned settings must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: COMPACTION_RESERVE_TOKENS,
        keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
      },
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

export function readOwnedPiSettings(directory: string): EffectivePiSettings {
  ensureDirectoryChain(path.dirname(directory));
  assertOwnedDirectory(directory);
  const file = ownedPiSettings(directory);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Pi owned settings must be a regular file");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pi owned settings are invalid");
  const compaction = (parsed as Record<string, unknown>).compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) throw new Error("Pi owned compaction settings are missing");
  const values = compaction as Record<string, unknown>;
  const enabled = requireFiniteBoolean(values.enabled, "Pi owned compaction enabled");
  if (typeof values.reserveTokens !== "number" || typeof values.keepRecentTokens !== "number") {
    throw new Error("Pi owned compaction reserve/keep settings are invalid");
  }
  return { compaction: { enabled, reserveTokens: values.reserveTokens, keepRecentTokens: values.keepRecentTokens } };
}

export function parsePiExecutableVersion(output: string): "0.83.0" {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("Pi executable version output must contain exactly one version line");
  const line = lines[0];
  // Pi's bare version is canonical; permit only the fixed official display prefix.
  if (!/^(?:0\.83\.0|pi(?:-coding-agent)?(?:\s+version)?\s+v?0\.83\.0)$/i.test(line)) {
    throw new Error("Pi executable version must be exactly 0.83.0");
  }
  return "0.83.0";
}

export interface PiCapabilityProbe {
  distribution: "builtin" | "external";
  version?: string;
  contextWindow?: number;
  model?: { contextWindow?: number } | null;
  autoCompactionEnabled?: unknown;
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
  compactRpc?: boolean;
  events?: readonly string[];
  trustedProtocol?: boolean;
}

export function verifyPiCapabilities(capabilities: PiCapabilityProbe): void {
  if (capabilities.version !== "0.83.0") throw new Error("trusted Pi version 0.83.0 is required");
  if (capabilities.distribution === "external" && capabilities.trustedProtocol === true) {
    throw new Error("external Pi cannot use the bundled trusted protocol bypass");
  }
  const contextWindow = capabilities.contextWindow ?? capabilities.model?.contextWindow;
  if (contextWindow !== PI_CONTEXT_WINDOW) throw new Error("Pi capability context window is not 272000");
  if (requireFiniteBoolean(capabilities.autoCompactionEnabled, "Pi autoCompactionEnabled") !== true) {
    throw new Error("Pi effective native compaction is disabled");
  }
  if (capabilities.compactRpc !== true) throw new Error("Pi compact RPC capability is missing");
  if (capabilities.distribution === "builtin" && capabilities.trustedProtocol === true) return;
  if (capabilities.reserveTokens !== COMPACTION_RESERVE_TOKENS
      || capabilities.keepRecentTokens !== COMPACTION_KEEP_RECENT_TOKENS) {
    throw new Error("Pi external effective compaction reserve/keep settings are unproven");
  }
  const events = new Set(capabilities.events || []);
  for (const event of REQUIRED_PI_EVENTS) if (!events.has(event)) throw new Error(`Pi capability event is unproven: ${event}`);
}

function stateFile(root: string): string {
  return path.join(root, PI_COMPACTION_RECOVERY_FILE);
}

function assertStableIdentity(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid stable Pi compaction identity: ${name}`);
  }
}

function safeRecord(value: unknown): PiCompactionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Pi compaction breaker record");
  const record = value as Partial<PiCompactionRecord>;
  const manualAttempt = record.manualAttempt;
  const sessionGeneration = record.sessionGeneration;
  try {
    assertStableIdentity(record.key, "key"); assertStableIdentity(record.messageId, "messageId");
    assertStableIdentity(record.deliveryId, "deliveryId"); assertStableIdentity(record.inputId, "inputId");
  } catch { throw new Error("invalid Pi compaction breaker identity"); }
  if (typeof sessionGeneration !== "number" || !Number.isSafeInteger(sessionGeneration)
      || typeof record.state !== "string" || typeof manualAttempt !== "number" || !Number.isSafeInteger(manualAttempt)
      || manualAttempt < 0 || manualAttempt > 1 || typeof record.updatedAt !== "string") {
    throw new Error("invalid Pi compaction breaker identity");
  }
  if (record.compactSentAt !== null && typeof record.compactSentAt !== "string") throw new Error("invalid compactSentAt");
  if (record.compactDeadlineAt !== null && typeof record.compactDeadlineAt !== "string") throw new Error("invalid compactDeadlineAt");
  if (record.compactFinishedAt !== null && typeof record.compactFinishedAt !== "string") throw new Error("invalid compactFinishedAt");
  if (record.retrySubmittedAt !== null && typeof record.retrySubmittedAt !== "string") throw new Error("invalid retrySubmittedAt");
  if (record.fallbackReason !== null && typeof record.fallbackReason !== "string") throw new Error("invalid fallbackReason");
  if (record.compactResponseReceived !== undefined && typeof record.compactResponseReceived !== "boolean") throw new Error("invalid compactResponseReceived");
  if (record.compactionLifecycleSucceeded !== undefined && typeof record.compactionLifecycleSucceeded !== "boolean") throw new Error("invalid compactionLifecycleSucceeded");
  if (!(new Set<PiCompactionState>([
    "eligible", "native_compacting", "native_retry_owned", "native_succeeded", "native_failed", "settled_for_manual",
    "manual_sent", "manual_succeeded", "manual_failed", "manual_ambiguous", "retrying", "second_overflow",
    "fallback_required", "fallback_committed", "closed",
  ])).has(record.state as PiCompactionState)) throw new Error("unknown Pi compaction breaker state");
  return {
    key: record.key, messageId: record.messageId, deliveryId: record.deliveryId, inputId: record.inputId,
    sessionGeneration: sessionGeneration as number, state: record.state as PiCompactionState,
    manualAttempt: manualAttempt as number, compactSentAt: record.compactSentAt ?? null,
    compactDeadlineAt: record.compactDeadlineAt ?? null, compactFinishedAt: record.compactFinishedAt ?? null,
    retrySubmittedAt: record.retrySubmittedAt ?? null, fallbackReason: record.fallbackReason ?? null,
    ...(record.compactResponseReceived !== undefined ? { compactResponseReceived: record.compactResponseReceived } : {}),
    ...(record.compactionLifecycleSucceeded !== undefined ? { compactionLifecycleSucceeded: record.compactionLifecycleSucceeded } : {}),
    updatedAt: record.updatedAt,
  };
}

export class PiCompactionBreaker {
  private readonly file: string;
  private readonly clock: () => string;
  private records: Map<string, PiCompactionRecord>;
  private readonly withLock?: <T>(operation: () => T) => T;
  constructor(private readonly root: string, options: { now?: () => string; retentionMs?: number; withLock?: <T>(operation: () => T) => T } = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    ensureDirectory(root);
    this.file = stateFile(root);
    this.clock = options.now ?? (() => new Date().toISOString());
    this.records = new Map(this.read().records.map((record) => [record.key, record]));
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.withLock = options.withLock;
  }
  private readonly retentionMs: number;

  private runLocked<T>(operation: () => T): T {
    if (!this.withLock) throw new Error("Pi compaction breaker requires the canonical Agent state lock");
    return this.withLock(operation);
  }

  private read(): PiCompactionFile {
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Pi compaction breaker must be a regular file");
      if (process.platform !== "win32" && ((typeof process.getuid === "function" && stat.uid !== process.getuid())
          || (stat.mode & 0o777) !== 0o600)) throw new Error("Pi compaction breaker must be owner-only 0600");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PiCompactionFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("unknown Pi compaction breaker version");
      return { version: 1, records: parsed.records.map(safeRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
  }

  private persist(): void {
    const temporary = path.join(this.root, `.${path.basename(this.file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const content = `${JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2)}\n`;
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) throw new Error("Pi compaction breaker write verification failed");
    } finally {
      if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* preserve primary error */ } }
      try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
    }
  }

  private reload(): void {
    this.records = new Map(this.read().records.map((record) => [record.key, record]));
  }

  get(key: string): PiCompactionRecord | undefined {
    return this.runLocked(() => { this.reload(); const record = this.records.get(key); return record ? { ...record } : undefined; });
  }

  listNonTerminal(): PiCompactionRecord[] {
    return this.runLocked(() => { this.reload(); return [...this.records.values()].filter((record) => !TERMINAL_STATES.has(record.state)).map((record) => ({ ...record })); });
  }

  save(record: PiCompactionRecord): void {
    this.runLocked(() => { this.reload(); const checked = safeRecord({ ...record, updatedAt: this.clock() }); this.records.set(checked.key, checked); this.persist(); });
  }

  private transitionUnlocked(key: string, patch: Partial<PiCompactionRecord>, state: PiCompactionState): PiCompactionRecord {
    this.reload();
    const current = this.records.get(key);
    if (!current) {
      const sessionGeneration = patch.sessionGeneration;
      if (state !== "eligible" || !patch.messageId || !patch.deliveryId || !patch.inputId
          || typeof sessionGeneration !== "number" || !Number.isSafeInteger(sessionGeneration)) {
        throw new Error("invalid initial Pi compaction breaker transition");
      }
      const record: PiCompactionRecord = {
        key, messageId: patch.messageId, deliveryId: patch.deliveryId, inputId: patch.inputId,
        sessionGeneration, state, manualAttempt: 0,
        compactSentAt: null, compactDeadlineAt: null, compactFinishedAt: null, retrySubmittedAt: null,
        fallbackReason: null, updatedAt: this.clock(),
      };
      this.records.set(key, record); this.persist(); return { ...record };
    }
    if (current.state === state) throw new Error(`duplicate Pi compaction transition: ${state}`);
    if (TERMINAL_STATES.has(current.state)) throw new Error(`Pi compaction breaker is terminal: ${current.state}`);
    if (!ALLOWED_TRANSITIONS[current.state].includes(state)) throw new Error(`invalid Pi compaction transition ${current.state} -> ${state}`);
    const next = { ...current, ...patch, key, state, updatedAt: this.clock() };
    if (next.key !== current.key || next.messageId !== current.messageId || next.deliveryId !== current.deliveryId
        || next.inputId !== current.inputId || next.sessionGeneration !== current.sessionGeneration) {
      throw new Error("Pi compaction breaker stable identity is immutable");
    }
    if (state === "manual_sent") {
      if (current.state !== "settled_for_manual" || current.manualAttempt >= 1) throw new Error("manual compact attempt already used");
      next.manualAttempt = 1;
    }
    safeRecord(next);
    this.records.set(key, next);
    this.persist();
    return { ...next };
  }

  transition(key: string, patch: Partial<PiCompactionRecord>, state: PiCompactionState): PiCompactionRecord {
    return this.runLocked(() => this.transitionUnlocked(key, patch, state));
  }

  transitionInTransaction(key: string, patch: Partial<PiCompactionRecord>, state: PiCompactionState): PiCompactionRecord {
    return this.transitionUnlocked(key, patch, state);
  }

  prune(consumedKeys: readonly string[] = []): number {
    return this.runLocked(() => this.pruneUnlocked(consumedKeys));
  }

  private pruneUnlocked(consumedKeys: readonly string[] = []): number {
    this.reload();
    const consumed = new Set(consumedKeys);
    const cutoff = Date.parse(this.clock()) - this.retentionMs;
    let count = 0;
    for (const [key, record] of this.records) {
      if (!TERMINAL_STATES.has(record.state) || !consumed.has(key)) continue;
      if (!Number.isFinite(cutoff) || Date.parse(record.updatedAt) > cutoff) continue;
      this.records.delete(key); count += 1;
    }
    if (count) this.persist();
    return count;
  }

  forceFallback(key: string, reason: string): PiCompactionRecord {
    return this.runLocked(() => {
      this.reload();
      const current = this.records.get(key);
      if (!current) throw new Error("Pi compaction breaker record is missing");
      if (TERMINAL_STATES.has(current.state)) return { ...current };
      const next = { ...current, state: "fallback_required" as const, fallbackReason: reason, updatedAt: this.clock() };
      safeRecord(next); this.records.set(key, next); this.persist(); return { ...next };
    });
  }

  forceFallbackInTransaction(key: string, reason: string): PiCompactionRecord {
    this.reload();
    const current = this.records.get(key);
    if (!current) throw new Error("Pi compaction breaker record is missing");
    if (TERMINAL_STATES.has(current.state)) return { ...current };
    const next = { ...current, state: "fallback_committed" as const, fallbackReason: reason, updatedAt: this.clock() };
    safeRecord(next); this.records.set(key, next); this.persist(); return { ...next };
  }
}

export type PiCompactionAction = "arm_manual_compact" | "manual_compact" | "retry_input" | "fresh_session_fallback";

interface BreakerLike {
  get?(key: string): PiCompactionRecord | undefined;
  transition?(key: string, patch: Partial<PiCompactionRecord>, state: PiCompactionState): PiCompactionRecord;
  save?(record: PiCompactionRecord): void;
  forceFallback?(key: string, reason: string): PiCompactionRecord;
}

export class PiCompactionRecoveryMachine {
  readonly key: string;
  private record: PiCompactionRecord;
  private readonly breaker: BreakerLike;
  private readonly onAction: (action: PiCompactionAction) => void;
  constructor(input: {
    breaker: BreakerLike; key: string; messageId: string; deliveryId: string; inputId: string; sessionGeneration: number;
    onAction?: (action: PiCompactionAction) => void;
  }) {
    this.key = input.key;
    this.breaker = input.breaker;
    this.onAction = input.onAction ?? (() => {});
    this.record = input.breaker.get?.(input.key) ?? {
      key: input.key, messageId: input.messageId, deliveryId: input.deliveryId, inputId: input.inputId,
      sessionGeneration: input.sessionGeneration, state: "eligible", manualAttempt: 0,
      compactSentAt: null, compactDeadlineAt: null, compactFinishedAt: null, retrySubmittedAt: null,
      fallbackReason: null, updatedAt: new Date().toISOString(),
    };
  }
  get state(): PiCompactionState { return this.record.state; }
  get recordSnapshot(): PiCompactionRecord { return { ...this.record }; }

  private change(state: PiCompactionState, patch: Partial<PiCompactionRecord> = {}): void {
    if (TERMINAL_STATES.has(this.record.state) || this.record.state === "fallback_required") return;
    this.record = { ...this.record, ...patch, state, updatedAt: new Date().toISOString() };
    if (this.breaker.transition) {
      try { this.record = this.breaker.transition(this.key, this.record, state); } catch (error) {
        if (this.breaker.get?.(this.key)) throw error;
        this.breaker.save?.(this.record);
      }
    } else this.breaker.save?.(this.record);
  }

  agentEnd(input: { exactOverflow: boolean; willRetry: boolean }): void {
    if (!input.exactOverflow || TERMINAL_STATES.has(this.state) || this.state === "fallback_required") return;
    if (["native_compacting", "native_retry_owned", "native_succeeded"].includes(this.state)) return;
    if (this.state === "retrying") {
      this.change("second_overflow", { fallbackReason: "second exact context overflow" });
      this.onAction("fresh_session_fallback");
      return;
    }
    if (input.willRetry) this.change("native_retry_owned");
  }

  compactionStart(input: { reason: "overflow" | "threshold" | "manual" }): void {
    if (input.reason === "overflow" && (this.state === "eligible" || this.state === "native_retry_owned")) this.change("native_compacting");
  }

  compactionEnd(input: { reason: "overflow" | "manual"; success: boolean; willRetry: boolean }): void {
    if (this.state === "fallback_required" || TERMINAL_STATES.has(this.state)) return;
    if (input.reason === "overflow") {
      if (this.state === "native_retry_owned" || this.state === "native_compacting" || this.state === "eligible") {
        if (input.success && input.willRetry) this.change("native_succeeded");
        else { this.change("native_failed", { fallbackReason: "native overflow compaction failed" }); this.onAction("fresh_session_fallback"); }
      }
      return;
    }
    if (this.state !== "manual_sent") return;
    if (!input.success) {
      this.change("manual_failed", { fallbackReason: "manual compaction failed" });
      this.onAction("fresh_session_fallback");
      return;
    }
    this.record = { ...this.record, compactionLifecycleSucceeded: true };
    if (this.record.compactResponseReceived) {
      this.change("manual_succeeded", { compactFinishedAt: new Date().toISOString() });
      this.onAction("retry_input");
    }
  }

  agentSettled(): void {
    if (this.state !== "eligible") return;
    this.change("settled_for_manual");
    this.onAction("arm_manual_compact");
  }

  manualCompactSent(deadlineAt: string): void {
    if (this.state !== "settled_for_manual" || this.record.manualAttempt >= 1) return;
    this.change("manual_sent", { manualAttempt: 1, compactSentAt: new Date().toISOString(), compactDeadlineAt: deadlineAt });
    this.onAction("manual_compact");
  }

  compactResponse(input: { success: boolean; ambiguous?: boolean }): void {
    if (this.state !== "manual_sent") return;
    if (!input.success) {
      this.change(input.ambiguous ? "manual_ambiguous" : "manual_failed", {
        fallbackReason: input.ambiguous ? "manual compact response became ambiguous after send" : "manual compact RPC failed",
      });
      this.onAction("fresh_session_fallback");
      return;
    }
    this.record = { ...this.record, compactResponseReceived: true };
    if (this.record.compactionLifecycleSucceeded) {
      this.change("manual_succeeded", { compactFinishedAt: new Date().toISOString() });
      this.onAction("retry_input");
    }
  }

  compactTimeout(): void {
    if (this.state !== "manual_sent") return;
    this.change("manual_ambiguous", { fallbackReason: "manual compact deadline expired" });
    this.onAction("fresh_session_fallback");
  }

  retrySubmitted(): void {
    if (this.state !== "manual_succeeded") return;
    this.change("retrying", { retrySubmittedAt: new Date().toISOString() });
  }

  fallbackRequired(reason: string): void {
    if (TERMINAL_STATES.has(this.state)) return;
    if (this.breaker.forceFallback) this.record = this.breaker.forceFallback(this.key, reason);
    else this.change("fallback_required", { fallbackReason: reason });
    this.onAction("fresh_session_fallback");
  }

  fallbackCommitted(): void {
    if (!["native_failed", "manual_failed", "manual_ambiguous", "second_overflow", "fallback_required"].includes(this.state)) return;
    this.change("fallback_committed");
  }

  close(): void {
    if (["native_succeeded", "retrying", "fallback_committed"].includes(this.state)) this.change("closed");
  }
}

export function prepareOwnedPiEnvironment(input: { root: string; agentId: string; env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const directory = ensureOwnedPiAgentDirectory(input.root, input.agentId);
  writeOwnedPiSettings(directory);
  return { ...input.env, PI_CODING_AGENT_DIR: directory };
}

export function readProjectPiSettings(workspaceDir: string): Record<string, unknown> | null {
  const file = path.join(workspaceDir, ".pi", "settings.json");
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("project Pi settings must be a regular file");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("project Pi settings are invalid");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function assertNoProjectPiCompactionOverride(workspaceDir: string): void {
  const settings = readProjectPiSettings(workspaceDir);
  if (settings && hasProjectPiCompactionOverride(settings)) throw new Error("project Pi compaction/context settings override Larkin policy");
}

export function currentUserLabel(): string { return os.userInfo().username; }
