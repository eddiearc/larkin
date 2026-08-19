import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentCliPromptCapabilities } from "../agent/agent-cli-capabilities.js";
import { isCanonicalInboxTarget, targetKeyOfInboxEnvelope } from "../agent/inbox-projection.js";
import type { ContextOverflowRearmResult, InboxDeliverySourceResolution } from "../agent/agent-state-store.js";
import { SpanKind } from "@opentelemetry/api";
import type { ContextPromptBuilder } from "../agent/context-prompt.js";
import type {
  NormalizedRuntimeEvent, RuntimeAdapter, RuntimeInput, RuntimeInputResult, RuntimeSession,
} from "./runtime-contracts.js";
import { buildStrictProviderErrorInput, classifyStrictProviderError } from "./provider-error-classifier.js";
import {
  classifyRuntimePrerequisite,
  providerAuthenticationFailureReadiness,
  RuntimePrerequisiteError,
  type RuntimeReadiness,
} from "./runtime-readiness.js";
import { resolveOfficialLarkCli } from "../app/official-lark-cli.js";
import { assertAgentWorkspaceBound, managedLarkCliEnv } from "../app/agent-lark-cli-workspace.js";
import type { TelemetryRuntime } from "../platform/telemetry-tracing.js";
import {
  isPiNativeCompactionRequired,
  PiCompactionBreaker,
  PiCompactionRecoveryMachine,
} from "./pi-compaction-recovery.js";

export interface AgentRuntimeConfig {
  agentId: string; name: string; displayName?: string | null; description?: string | null;
  runtime: string; model: string; effort?: string | null; workspaceDir: string;
  piDistribution?: "external" | "builtin";
  stateDir?: string; sessionId?: string | null;
  larkConfigDir?: string;
  feishuAppId?: string;
}

export type DeliveryStatus = "pending" | "submitting" | "accepted" | "consumed" | "error";
export interface DeliveryRecord {
  deliveryId: string; messageId: string; status: DeliveryStatus; input: RuntimeInput; updatedAt: string;
  /** Structured canonical target is authoritative; RuntimeInput.text is always rebuilt before submission. */
  target?: string;
  wakeReason?: string;
  reason?: string; retryable?: boolean; errorCategory?: string;
}
interface DeliveryFile { version: 1; records: DeliveryRecord[] }
interface DeliveryStateStore {
  readJson<T>(key: "runtimeDeliveries", fallback: T): T;
  readNdjson?<T>(key: "inbox"): T[];
  writeJson(key: "runtimeDeliveries", value: unknown): void;
  withInboxTransaction<T>(operation: () => T): T;
  resolveInboxDeliverySource?(messageId: string): InboxDeliverySourceResolution;
  rearmContextOverflow?(onCommit?: (messageIds: readonly string[], rollback: () => void) => void, expected?: {
    messageId?: string; deliveryId?: string; inputId?: string;
  }): ContextOverflowRearmResult;
}

export type RuntimeHostEvent =
  | { type: "agent-status"; agentId: string; status: "active" | "inactive" | "error"; error?: string; readiness?: RuntimeReadiness }
  | { type: "session"; agentId: string; runtime: string; sessionId: string | null; launchId: string; model?: string; reasoningEffort?: string }
  | { type: "activity"; agentId: string; activity: string; activityKind?: string; detailKind?: string; isHeartbeat?: boolean }
  | { type: "delivery"; agentId: string; deliveryId: string; messageId: string; status: "accepted" | "consumed" | "deferred" | "error"; reason?: string }
  | { type: "runtime"; agentId: string; event: NormalizedRuntimeEvent };

export type DeliveryReceipt =
  | { status: "accepted"; deliveryId: string }
  | { status: "duplicate"; deliveryId: string }
  | { status: "deferred"; deliveryId: string; reason: string }
  | { status: "error"; deliveryId: string; reason: string; retryable: false };

interface ManagedAgent {
  config: AgentRuntimeConfig; adapter: RuntimeAdapter; session: RuntimeSession | null;
  launchId: string; busy: boolean; submitting: boolean; starting: Promise<RuntimeSession> | null;
  retryAfterSubmit: boolean; retryPendingInFlight: Promise<void> | null;
  records: Map<string, DeliveryRecord>; byMessage: Map<string, string>; generation: number;
  poller: NodeJS.Timeout | null; retryTimer: NodeJS.Timeout | null; recreateAttempts: number;
  stabilityTimer: NodeJS.Timeout | null; recreateReason: string | null;
  stopped: boolean; disabledReason: string | null; configurationRecovery: Promise<void> | null;
  stateStore?: DeliveryStateStore;
  compactionBreaker?: PiCompactionBreaker;
  compactionMachines: Map<string, PiCompactionRecoveryMachine>;
  compactionRecoveryInFlight: Set<string>;
  piOverflowCompactionFailed: Set<string>;
  piProactiveCompaction: Promise<"noop" | "succeeded" | "failed"> | null;
  piProactiveCompactionGeneration: number | null;
  piProactiveCompactionSession: RuntimeSession | null;
  piProactiveCompactionFailedGeneration: number | null;
  readiness: RuntimeReadiness | null;
  turnInProgress: boolean; turnHadFailure: boolean; turnHadAuthenticatedOutput: boolean; authFailureActive: boolean;
  /** Delivery ids already promoted from accepted inbox_update to a wake while idle. */
  promotedInboxUpdateIds: Set<string>;
  backgroundCompletionQueue: string[]; backgroundCompletionKeys: Set<string>;
  backgroundCompletionInFlight: string | null; backgroundCompletionWakeInputId: string | null;
  backgroundCompletionRejectStreak: number;
  backgroundCompletionRetryTimer: NodeJS.Timeout | null;
}

export interface RuntimeHost {
  probe?(config: AgentRuntimeConfig): Promise<RuntimeReadiness>;
  stage?(config: AgentRuntimeConfig): Promise<StagedRuntimeCandidate>;
  start(configs: AgentRuntimeConfig[]): Promise<void>;
  deliver(agentId: string, envelope: Record<string, unknown>): Promise<DeliveryReceipt>;
  stop(agentId: string, reason: string): Promise<void>;
  shutdown(reason: string): Promise<void>;
  subscribe(listener: (event: RuntimeHostEvent) => void): () => void;
  isBusy?(agentId: string): boolean;
  /** Promote accepted inbox_update deliveries once after idle / drought reconnect. */
  scanPendingInboxUpdates?(agentId?: string): Promise<void>;
  resetSession?(agentId: string): Promise<RuntimeSessionResetResult>;
  recoverSession?(agentId: string, reason: "context-overflow"): Promise<RuntimeSessionRecoveryResult>;
  /** Internal recovery boundary for Pi compaction failures; never exposed as session reset. */
  recoverContextOverflow?(agentId: string, deliveryKey: string, reason: string): Promise<RuntimeSessionRecoveryResult>;
}

export interface RuntimeSessionResetResult {
  generationChanged: boolean;
  sessionChanged: boolean;
  turns: 0;
  runtimeReady: true;
  pendingCount: 0;
  sessionId: string | null;
}

export interface RuntimeSessionRecoveryResult {
  generationChanged: boolean;
  sessionChanged: boolean;
  turns: 0;
  runtimeReady: true;
  pendingCount: number;
  rearmedCount: number;
  replayStatus: "scheduled" | "pending" | "consumed";
  sessionId: string | null;
}

export class RuntimeSessionResetError extends Error {
  constructor(readonly code: "unknown_agent" | "agent_busy" | "inbox_backlog", message: string, readonly pendingCount = 0) {
    super(message);
    this.name = "RuntimeSessionResetError";
  }
}

export class RuntimeSessionRecoveryError extends Error {
  constructor(readonly code: "unknown_agent" | "agent_busy" | "recovery_unavailable" | "recovery_refused" | "recovery_staged_not_committed", message: string, readonly pendingCount = 0) {
    super(message);
    this.name = "RuntimeSessionRecoveryError";
  }
}

export interface StagedRuntimeCandidate {
  readonly readiness: RuntimeReadiness;
  commit(): Promise<void>;
  rollback(reason: string): Promise<void>;
}

const MAX_DELIVERIES = 2048;
const BACKGROUND_COMPLETION_IMMEDIATE_RETRY_LIMIT = 5;
const now = (): string => new Date().toISOString();
const isActiveDelivery = (status: DeliveryStatus): boolean => ["pending", "submitting", "accepted"].includes(status);
type ReplayFailureCode = "canonical_inbox_row_missing" | "canonical_inbox_malformed" | "duplicate_message_id"
  | "inbox_state_conflict" | "delivery_target_conflict" | "structured_target_invalid"
  | "structured_target_missing" | "wake_reason_conflict";
const REPLAY_FAILURE_CODES: ReadonlySet<string> = new Set<ReplayFailureCode>([
  "canonical_inbox_row_missing", "canonical_inbox_malformed", "duplicate_message_id",
  "inbox_state_conflict", "delivery_target_conflict", "structured_target_invalid",
  "structured_target_missing", "wake_reason_conflict",
]);

function replayFailureReason(code: ReplayFailureCode): string {
  return `Runtime delivery quarantined (${code}): no safe canonical Inbox target is available; the Inbox/ledger remain durable for operator recovery`;
}

function replayFailureCodeOf(record: DeliveryRecord): ReplayFailureCode | null {
  if (record.status !== "error" || typeof record.reason !== "string") return null;
  const code = /^Runtime delivery quarantined \(([^)]+)\):/.exec(record.reason)?.[1];
  return code && REPLAY_FAILURE_CODES.has(code) ? code as ReplayFailureCode : null;
}

function deliveryFile(agent: ManagedAgent): string | null {
  return agent.config.stateDir ? path.join(agent.config.stateDir, "runtime-deliveries.json") : null;
}

function readDeliveryFile(file: string | null): DeliveryFile {
  if (!file) return { version: 1, records: [] };
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("delivery state is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DeliveryFile>;
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records.filter((record): record is DeliveryRecord =>
      Boolean(record?.deliveryId && record?.messageId && ["pending", "submitting", "accepted", "consumed", "error"].includes(record.status))) : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

function persist(agent: ManagedAgent): DeliveryRecord[] {
  const externallyConsumed: DeliveryRecord[] = [];
  if (agent.stateStore) {
    agent.stateStore.withInboxTransaction(() => {
      const external = agent.stateStore!.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] });
      for (const record of external.records || []) {
        const current = agent.records.get(record.deliveryId);
        if (current && current.status !== "consumed" && record.status === "consumed") {
          agent.records.set(record.deliveryId, record);
          externallyConsumed.push(record);
        }
      }
      const records = boundedRecords(agent);
      agent.stateStore!.writeJson("runtimeDeliveries", { version: 1, records });
    });
    return externallyConsumed;
  }
  const file = deliveryFile(agent);
  if (!file) return externallyConsumed;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
  if (existing?.isSymbolicLink()) throw new Error("delivery state must not be a symlink");
  const bounded = boundedRecords(agent);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, records: bounded }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return externallyConsumed;
}

function boundedRecords(agent: ManagedAgent): DeliveryRecord[] {
  const records = [...agent.records.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const active = records.filter((record) => isActiveDelivery(record.status));
  if (active.length > MAX_DELIVERIES) throw new Error(`runtime delivery backlog exceeds ${MAX_DELIVERIES}`);
  const terminal = records.filter((record) => !isActiveDelivery(record.status)).slice(-(MAX_DELIVERIES - Math.min(active.length, MAX_DELIVERIES)));
  const bounded = [...active, ...terminal].slice(-MAX_DELIVERIES);
  agent.records = new Map(bounded.map((record) => [record.deliveryId, record]));
  agent.byMessage = new Map(bounded.map((record) => [record.messageId, record.deliveryId]));
  prunePromotedInboxUpdateIds(agent);
  return bounded;
}

function prunePromotedInboxUpdateIds(agent: ManagedAgent): void {
  if (!agent.promotedInboxUpdateIds?.size) return;
  for (const id of agent.promotedInboxUpdateIds) {
    if (!agent.records.has(id)) agent.promotedInboxUpdateIds.delete(id);
  }
  if (agent.promotedInboxUpdateIds.size <= MAX_DELIVERIES) return;
  agent.promotedInboxUpdateIds = new Set([...agent.promotedInboxUpdateIds].slice(-MAX_DELIVERIES));
}

export function createRuntimeHost(options: {
  adapterFor(runtime: string): RuntimeAdapter; promptBuilder: ContextPromptBuilder; log?: (...parts: unknown[]) => void;
  stateStoreFor?(agentId: string): DeliveryStateStore;
  assertOfficialCliReady?(config: AgentRuntimeConfig, env: NodeJS.ProcessEnv): void | Promise<void>;
  retryPolicy?: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; stableWindowMs?: number };
  compactTimeoutMs?: number;
  telemetry?: TelemetryRuntime;
}): RuntimeHost {
  const managed = new Map<string, ManagedAgent>();
  const listeners = new Set<(event: RuntimeHostEvent) => void>();
  const log = options.log ?? (() => {});
  const telemetry = options.telemetry;
  const compactTimeoutMs = options.compactTimeoutMs ?? 120_000;
  if (!Number.isFinite(compactTimeoutMs) || compactTimeoutMs <= 0) throw new Error("compactTimeoutMs must be positive");
  const retryPolicy = {
    baseDelayMs: options.retryPolicy?.baseDelayMs ?? 250,
    maxDelayMs: options.retryPolicy?.maxDelayMs ?? 10_000,
    maxAttempts: options.retryPolicy?.maxAttempts ?? 6,
    stableWindowMs: options.retryPolicy?.stableWindowMs ?? 30_000,
  };
  const emit = (event: RuntimeHostEvent): void => {
    if (event.type === "delivery") telemetry?.delivery(event.agentId, event.messageId, event.status);
    for (const listener of listeners) listener(event);
  };
  const runtimeEnv = (config: AgentRuntimeConfig, generation?: string): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      LARKIN_AGENT_ID: config.agentId,
    ...(generation ? { LARKIN_RUNTIME_OBSERVATION_GENERATION: generation } : {}),
    LARKIN_CONFIG_DIR: process.env.LARKIN_CONFIG_DIR,
    LARKIN_HOME: process.env.LARKIN_HOME,
    ...(config.piDistribution ? { LARKIN_PI_DISTRIBUTION: config.piDistribution } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}),
    ...(process.env.ZDOTDIR ? { ZDOTDIR: process.env.ZDOTDIR } : {}),
    ...(process.env.BASH_ENV ? { BASH_ENV: process.env.BASH_ENV } : {}),
    PATH: [config.stateDir ? path.join(config.stateDir, "runtime-bin") : null, process.env.PATH].filter(Boolean).join(path.delimiter),
      LARKSUITE_CLI_CONFIG_DIR: config.larkConfigDir ?? process.env.LARKSUITE_CLI_CONFIG_DIR,
    };
    return config.larkConfigDir ? managedLarkCliEnv(config, base) : base;
  };
  const assertOfficialCliReady = async (config: AgentRuntimeConfig, env: NodeJS.ProcessEnv): Promise<void> => {
    if (!config.larkConfigDir) return;
    if (options.assertOfficialCliReady) await options.assertOfficialCliReady(config, env);
    else {
      resolveOfficialLarkCli({ env });
      assertAgentWorkspaceBound(config as Parameters<typeof assertAgentWorkspaceBound>[0]);
    }
  };

  const emitConsumed = (agent: ManagedAgent, records: DeliveryRecord[]): void => {
    for (const record of records) emit({ type: "delivery", agentId: agent.config.agentId,
      deliveryId: record.deliveryId, messageId: record.messageId, status: "consumed" });
  };

  const markSessionStable = (agent: ManagedAgent, session: RuntimeSession): void => {
    if (agent.session !== session || agent.stopped) return;
    if (agent.stabilityTimer) clearTimeout(agent.stabilityTimer);
    agent.stabilityTimer = null;
    agent.recreateAttempts = 0;
    agent.recreateReason = null;
  };

  const setRecord = (agent: ManagedAgent, record: DeliveryRecord, status: DeliveryStatus): DeliveryRecord => {
    record.status = status; record.updatedAt = now(); agent.records.set(record.deliveryId, record);
    agent.byMessage.set(record.messageId, record.deliveryId);
    emitConsumed(agent, persist(agent));
    return agent.records.get(record.deliveryId) ?? record;
  };

  type RecordInputPreparation =
    | { status: "ready"; target: string }
    | { status: "consumed" }
    | { status: "error"; code: ReplayFailureCode; reason: string };

  const scrubQuarantinedInput = (record: DeliveryRecord, reason: string): void => {
    const staleInput = record.input && typeof record.input === "object" ? record.input : null;
    record.input = {
      inputId: typeof staleInput?.inputId === "string" && staleInput.inputId ? staleInput.inputId : record.deliveryId,
      deliveryId: record.deliveryId,
      kind: "wake",
      text: reason,
      attempt: Number.isSafeInteger(staleInput?.attempt) && Number(staleInput?.attempt) >= 0 ? Number(staleInput!.attempt) : 0,
    };
  };

  /** Rebuild every submitted notice from canonical structured state, never persisted text. */
  const prepareRecordInput = (agent: ManagedAgent, record: DeliveryRecord, busy: boolean): RecordInputPreparation => {
    if (record.target !== undefined && (typeof record.target !== "string" || !isCanonicalInboxTarget(record.target))) {
      return { status: "error", code: "structured_target_invalid", reason: replayFailureReason("structured_target_invalid") };
    }
    if (record.wakeReason !== undefined && typeof record.wakeReason !== "string") {
      return { status: "error", code: "wake_reason_conflict", reason: replayFailureReason("wake_reason_conflict") };
    }
    let target = typeof record.target === "string" ? record.target : null;
    let wakeReason = typeof record.wakeReason === "string" ? record.wakeReason : undefined;
    if (agent.stateStore?.resolveInboxDeliverySource) {
      let source: InboxDeliverySourceResolution;
      try { source = agent.stateStore.resolveInboxDeliverySource(record.messageId); }
      catch { source = { status: "invalid", code: "canonical_inbox_malformed" }; }
      if (source.status === "consumed") return { status: "consumed" };
      if (source.status === "missing" || source.status === "invalid") {
        return { status: "error", code: source.code, reason: replayFailureReason(source.code) };
      }
      if (target && target !== source.target) {
        return { status: "error", code: "delivery_target_conflict", reason: replayFailureReason("delivery_target_conflict") };
      }
      const canonicalWakeReason = typeof source.envelope.wake_reason === "string" ? source.envelope.wake_reason : undefined;
      if (record.wakeReason !== undefined && wakeReason !== canonicalWakeReason) {
        return { status: "error", code: "wake_reason_conflict", reason: replayFailureReason("wake_reason_conflict") };
      }
      target = source.target;
      wakeReason = canonicalWakeReason;
    }
    if (!target) return { status: "error", code: "structured_target_missing", reason: replayFailureReason("structured_target_missing") };
    const staleInput = record.input && typeof record.input === "object" ? record.input : null;
    const attempt = Number.isSafeInteger(staleInput?.attempt) && Number(staleInput?.attempt) >= 0 ? Number(staleInput!.attempt) : 0;
    const inputId = typeof staleInput?.inputId === "string" && staleInput.inputId ? staleInput.inputId : record.deliveryId;
    record.target = target;
    if (wakeReason) record.wakeReason = wakeReason;
    else delete record.wakeReason;
    record.input = {
      inputId,
      deliveryId: record.deliveryId,
      kind: busy ? "inbox_update" : "wake",
      text: options.promptBuilder.buildInboxNotice({ busy, count: 1, deliveryId: record.deliveryId, target,
        ...(wakeReason ? { wakeReason } : {}) }),
      attempt,
    };
    return { status: "ready", target };
  };

  const quarantineRecord = (agent: ManagedAgent, record: DeliveryRecord, code: ReplayFailureCode): DeliveryReceipt => {
    const reason = replayFailureReason(code);
    scrubQuarantinedInput(record, reason);
    record.reason = reason;
    record.retryable = false;
    delete record.errorCategory;
    const finalRecord = setRecord(agent, record, "error");
    if (finalRecord.status === "consumed") return { status: "accepted", deliveryId: record.deliveryId };
    emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
      messageId: record.messageId, status: "error", reason });
    return { status: "error", deliveryId: record.deliveryId, reason, retryable: false };
  };

  const reconcileExternalConsumption = (agent: ManagedAgent): void => {
    if (agent.stateStore) {
      agent.stateStore.withInboxTransaction(() => reconcileFile(agent,
        agent.stateStore!.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] })));
      return;
    }
    const file = deliveryFile(agent);
    if (!file) return;
    let external: DeliveryFile;
    try { external = readDeliveryFile(file); } catch (error) { log("delivery reconcile failed", String(error)); return; }
    reconcileFile(agent, external);
  };

  const reconcileFile = (agent: ManagedAgent, external: DeliveryFile): void => {
    for (const next of external.records || []) {
      const current = agent.records.get(next.deliveryId);
      if (current && current.status !== "consumed" && next.status === "consumed") {
        agent.records.set(next.deliveryId, next);
        emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: next.deliveryId, messageId: next.messageId, status: "consumed" });
      }
    }
  };

  const TURN_END_RETRY_REASON = "runtime turn ended before Inbox consumption was observed";
  const INBOX_UPDATE_PROMOTE_REASON = "accepted inbox_update promoted after Agent became idle";
  const isInboxUpdateKind = (kind: unknown): boolean => kind === "inbox_update" || kind === "inbox-update";
  const agentIsIdleForInboxScan = (agent: ManagedAgent): boolean =>
    !agent.stopped && !agent.busy && !agent.submitting && !agent.turnInProgress && !agent.starting && Boolean(agent.session);
  const acceptedInboxStillPending = (agent: ManagedAgent, record: DeliveryRecord): boolean => {
    if (!agent.stateStore?.readNdjson) return true;
    try {
      return agent.stateStore.readNdjson<Record<string, unknown>>("inbox")
        .some((row) => row?.message_id === record.messageId);
    } catch {
      return false;
    }
  };

  /**
   * Runtime acceptance acknowledges only the notification. At the safe turn
   * boundary, canonical Inbox presence decides whether that same delivery
   * identity must become retryable again. The Inbox rows and ledger update are
   * observed under one transaction so a concurrent poll cannot be overwritten.
   */
  const reconcileAcceptedAtTurnEnd = (agent: ManagedAgent): void => {
    const store = agent.stateStore;
    if (!store?.readNdjson) {
      reconcileExternalConsumption(agent);
      for (const record of agent.records.values()) {
        if (record.status !== "accepted") continue;
        emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
          messageId: record.messageId, status: "deferred", reason: TURN_END_RETRY_REASON });
      }
      return;
    }
    const consumed: DeliveryRecord[] = [];
    const deferred: DeliveryRecord[] = [];
    try {
      store.withInboxTransaction(() => {
        const inboxIds = new Set(store.readNdjson!<Record<string, unknown>>("inbox").flatMap((row) =>
          typeof row?.message_id === "string" ? [row.message_id] : []));
        const disk = store.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] });
        let changed = false;
        const pendingUpdates: DeliveryRecord[] = [];
        const records = disk.records.map((candidate) => {
          const current = agent.records.get(candidate.deliveryId);
          if (!current) return candidate;
          if (candidate.status === "consumed") {
            if (current.status !== "consumed") {
              agent.records.set(candidate.deliveryId, candidate);
              consumed.push(candidate);
            }
            return candidate;
          }
          if (current.status !== "accepted" || candidate.status !== "accepted" || !inboxIds.has(candidate.messageId)) {
            return candidate;
          }
          const next: DeliveryRecord = { ...candidate, status: "pending", updatedAt: now(),
            reason: TURN_END_RETRY_REASON, retryable: true };
          changed = true;
          pendingUpdates.push(next);
          return next;
        });
        if (changed) {
          store.writeJson("runtimeDeliveries", { ...disk, records });
          for (const next of pendingUpdates) {
            agent.records.set(next.deliveryId, next);
            deferred.push(next);
          }
        }
      });
    } catch (error) {
      log("turn-end Inbox reconciliation failed", String(error));
      return;
    }
    emitConsumed(agent, consumed);
    for (const record of deferred) emit({ type: "delivery", agentId: agent.config.agentId,
      deliveryId: record.deliveryId, messageId: record.messageId, status: "deferred", reason: TURN_END_RETRY_REASON });
  };

  // Production callers persist the canonical Inbox before calling deliver(). If a
  // concurrent drain wins between that append and ledger creation, close only the
  // record created/observed by this call under the same Inbox lock.
  const reconcileAbsentCanonical = (agent: ManagedAgent, record: DeliveryRecord): void => {
    const store = agent.stateStore;
    if (!store?.readNdjson || !isActiveDelivery(record.status)) return;
    let consumed: DeliveryRecord | null = null;
    try {
      store.withInboxTransaction(() => {
        const present = store.readNdjson!<Record<string, unknown>>("inbox")
          .some((row) => row?.message_id === record.messageId);
        if (present) return;
        const disk = store.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] });
        let changed = false;
        const records = disk.records.map((candidate) => {
          if (candidate.deliveryId !== record.deliveryId || !isActiveDelivery(candidate.status)) return candidate;
          changed = true;
          consumed = { ...candidate, status: "consumed", updatedAt: now() };
          return consumed;
        });
        if (changed) store.writeJson("runtimeDeliveries", { ...disk, records });
      });
    } catch (error) {
      log("post-delivery Inbox reconciliation failed", String(error));
      return;
    }
    if (consumed) {
      agent.records.set(record.deliveryId, consumed);
      emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
        messageId: record.messageId, status: "consumed" });
    }
  };

  const resultFor = (agent: ManagedAgent, record: DeliveryRecord, result: RuntimeInputResult): DeliveryReceipt => {
    if (result.status === "accepted") {
      if (record.errorCategory !== "context_window") {
        delete record.reason;
        delete record.errorCategory;
      }
      delete record.retryable;
      const finalRecord = setRecord(agent, record, "accepted");
      if (finalRecord.status !== "consumed") emit({ type: "delivery", agentId: agent.config.agentId,
        deliveryId: record.deliveryId, messageId: record.messageId, status: "accepted" });
      return { status: "accepted", deliveryId: record.deliveryId };
    }
    if (record.errorCategory !== "context_window") delete record.errorCategory;
    const retryable = result.status === "deferred" || result.retryable;
    if (record.errorCategory !== "context_window") record.reason = result.reason;
    record.retryable = retryable;
    const finalRecord = setRecord(agent, record, retryable ? "pending" : "error");
    if (finalRecord.status === "consumed") return { status: "accepted", deliveryId: record.deliveryId };
    const status = retryable ? "deferred" : "error";
    emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId, messageId: record.messageId, status, reason: result.reason });
    return retryable
      ? { status: "deferred", deliveryId: record.deliveryId, reason: result.reason }
      : { status: "error", deliveryId: record.deliveryId, reason: result.reason, retryable: false };
  };

  const submit = async (agent: ManagedAgent, record: DeliveryRecord, busy: boolean): Promise<DeliveryReceipt> => {
    const proactive = agent.piProactiveCompaction
      && agent.piProactiveCompactionGeneration === agent.generation
      && agent.piProactiveCompactionSession === agent.session
      ? agent.piProactiveCompaction : null;
    if (proactive && await proactive === "failed") {
      return { status: "deferred", deliveryId: record.deliveryId, reason: "Pi proactive compaction failed for the current session generation" };
    }
    if (agent.adapter.id === "pi" && agent.piProactiveCompactionFailedGeneration === agent.generation) {
      return { status: "deferred", deliveryId: record.deliveryId, reason: "Pi proactive compaction failed for the current session generation" };
    }
    if (agent.adapter.id === "pi" && !busy && !agent.busy && !agent.turnInProgress && agent.session) {
      const idleGate = proactivelyCompactPiAtIdle(agent, agent.session);
      if (idleGate && await idleGate === "failed") {
        return { status: "deferred", deliveryId: record.deliveryId, reason: "Pi proactive compaction failed for the current session generation" };
      }
    }
    agent.submitting = true;
    if (!busy) agent.busy = true; // Reserve the turn before prompt() can yield.
    try {
      const prepared = prepareRecordInput(agent, record, busy);
      if (prepared.status === "consumed") {
        if (!busy) agent.busy = false;
        const consumedRecord = setRecord(agent, record, "consumed");
        emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: consumedRecord.deliveryId,
          messageId: consumedRecord.messageId, status: "consumed" });
        return { status: "accepted", deliveryId: record.deliveryId };
      }
      if (prepared.status === "error") {
        if (!busy) agent.busy = false;
        return quarantineRecord(agent, record, prepared.code);
      }
      const session = await ensureSession(agent);
      const submittingRecord = setRecord(agent, record, "submitting");
      if (submittingRecord.status === "consumed") {
        if (!busy) agent.busy = false;
        return { status: "accepted", deliveryId: record.deliveryId };
      }
      const result = await (busy ? session.busyInput(record.input) : session.prompt(record.input));
      if (agent.session !== session || agent.stopped) {
        return { status: "deferred", deliveryId: record.deliveryId, reason: "runtime session replaced before input result" };
      }
      if (result.status !== "accepted" && !busy) agent.busy = false;
      if (result.status === "accepted") markSessionStable(agent, session);
      return resultFor(agent, record, result);
    } catch (error) {
      if (!busy) agent.busy = false;
      const reason = error instanceof Error ? error.message : String(error);
      if (record.errorCategory !== "context_window") {
        record.reason = reason;
        delete record.errorCategory;
      }
      record.retryable = true;
      setRecord(agent, record, "pending");
      emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId, messageId: record.messageId, status: "deferred", reason });
      return { status: "deferred", deliveryId: record.deliveryId, reason };
    } finally {
      agent.submitting = false;
      if (agent.retryAfterSubmit && !agent.stopped) {
        agent.retryAfterSubmit = false;
        queueMicrotask(() => { void retryPending(agent); });
      }
      queueMicrotask(() => { void scanAndPromoteAcceptedInboxUpdates(agent); });
    }
  };

  const retryPending = async (agent: ManagedAgent): Promise<void> => {
    if (agent.retryPendingInFlight) return agent.retryPendingInFlight;
    const run = (async (): Promise<void> => {
    reconcileExternalConsumption(agent);
    const proactive = agent.piProactiveCompaction
      && agent.piProactiveCompactionGeneration === agent.generation
      && agent.piProactiveCompactionSession === agent.session
      ? agent.piProactiveCompaction : null;
    if (proactive && await proactive === "failed") return;
    if (agent.submitting || agent.starting) { agent.retryAfterSubmit = true; return; }
    if (agent.adapter.id === "pi" && agent.piProactiveCompactionFailedGeneration === agent.generation) return;
    if (agent.busy || agent.turnInProgress || !agent.session) return;
    if (agent.adapter.id === "pi") {
      const idleGate = proactivelyCompactPiAtIdle(agent, agent.session);
      if (idleGate && await idleGate === "failed") return;
    }
    const record = [...agent.records.values()].find((candidate) => candidate.status === "pending" || candidate.status === "submitting");
    if (record) await submit(agent, record, false);
    })();
    agent.retryPendingInFlight = run;
    try { await run; } finally {
      if (agent.retryPendingInFlight === run) agent.retryPendingInFlight = null;
    }
  };

  /**
   * After busy/submitting clears, accepted inbox_update notices have no later
   * turn boundary. Promote each delivery id at most once to a wake.
   */
  const scanAndPromoteAcceptedInboxUpdates = async (agent: ManagedAgent): Promise<void> => {
    if (!agentIsIdleForInboxScan(agent)) return;
    if (agent.compactionMachines.size > 0 || agent.compactionRecoveryInFlight.size > 0) return;
    const candidates = [...agent.records.values()].filter((record) => record.status === "accepted"
      && isInboxUpdateKind(record.input?.kind) && !agent.promotedInboxUpdateIds.has(record.deliveryId));
    if (!candidates.length) return;
    reconcileExternalConsumption(agent);
    let promoted = 0;
    for (const record of candidates) {
      const current = agent.records.get(record.deliveryId);
      if (current?.status !== "accepted") continue;
      if (!acceptedInboxStillPending(agent, current)) {
        reconcileAbsentCanonical(agent, current);
        continue;
      }
      agent.promotedInboxUpdateIds.add(current.deliveryId);
      current.reason = INBOX_UPDATE_PROMOTE_REASON;
      current.retryable = true;
      const finalRecord = setRecord(agent, current, "pending");
      if (finalRecord.status === "consumed") continue;
      emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: finalRecord.deliveryId,
        messageId: finalRecord.messageId, status: "deferred", reason: INBOX_UPDATE_PROMOTE_REASON });
      promoted += 1;
    }
    if (!promoted) return;
    if (agent.retryPendingInFlight) agent.retryAfterSubmit = true;
    await retryPending(agent);
  };

  const clearBackgroundCompletionRetryTimer = (agent: ManagedAgent): void => {
    if (!agent.backgroundCompletionRetryTimer) return;
    clearTimeout(agent.backgroundCompletionRetryTimer);
    agent.backgroundCompletionRetryTimer = null;
  };

  const scheduleBackgroundCompletionDrain = (agent: ManagedAgent, delayMs = 0): void => {
    if (agent.stopped) return;
    if (delayMs > 0) {
      if (agent.backgroundCompletionRetryTimer) return;
      agent.backgroundCompletionRetryTimer = setTimeout(() => {
        agent.backgroundCompletionRetryTimer = null;
        if (agent.stopped) return;
        void drainBackgroundCompletionQueue(agent);
      }, delayMs);
      agent.backgroundCompletionRetryTimer.unref?.();
      return;
    }
    clearBackgroundCompletionRetryTimer(agent);
    queueMicrotask(() => { void drainBackgroundCompletionQueue(agent); });
  };

  const dropBackgroundCompletion = (agent: ManagedAgent, completionKey: string | null): void => {
    if (!completionKey) return;
    if (agent.backgroundCompletionQueue[0] === completionKey) agent.backgroundCompletionQueue.shift();
    else {
      const index = agent.backgroundCompletionQueue.indexOf(completionKey);
      if (index >= 0) agent.backgroundCompletionQueue.splice(index, 1);
    }
    agent.backgroundCompletionKeys.add(completionKey);
    if (agent.backgroundCompletionInFlight === completionKey) {
      agent.backgroundCompletionInFlight = null;
      agent.backgroundCompletionWakeInputId = null;
    }
    agent.backgroundCompletionRejectStreak = 0;
    clearBackgroundCompletionRetryTimer(agent);
  };

  const scheduleBackgroundCompletionRetry = (agent: ManagedAgent): void => {
    const streak = agent.backgroundCompletionRejectStreak;
    if (streak < BACKGROUND_COMPLETION_IMMEDIATE_RETRY_LIMIT) {
      scheduleBackgroundCompletionDrain(agent);
      return;
    }
    const delayedAttempt = streak - BACKGROUND_COMPLETION_IMMEDIATE_RETRY_LIMIT;
    if (delayedAttempt >= retryPolicy.maxAttempts) {
      const exhausted = agent.backgroundCompletionQueue[0];
      if (exhausted) {
        log("background completion wake retries exhausted", exhausted);
        dropBackgroundCompletion(agent, exhausted);
      }
      if (agent.backgroundCompletionQueue.length > 0) scheduleBackgroundCompletionDrain(agent);
      return;
    }
    const delay = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** delayedAttempt);
    scheduleBackgroundCompletionDrain(agent, delay);
  };

  const isPersistentBackgroundWakeFailure = (event?: {
    retryable?: boolean; errorCategory?: string;
  }): boolean => {
    if (!event) return false;
    const category = event.errorCategory;
    if (category === "auth" || category === "billing" || category === "quota") return true;
    return category === "provider" && event.retryable === false;
  };

  const failBackgroundCompletionWake = (agent: ManagedAgent, event?: {
    retryable?: boolean; errorCategory?: string;
  }): void => {
    const completionKey = agent.backgroundCompletionInFlight ?? agent.backgroundCompletionQueue[0];
    if (!completionKey) return;
    rearmBackgroundCompletion(agent, completionKey);
    if (isPersistentBackgroundWakeFailure(event)) {
      log("background completion wake dropped", event?.errorCategory ?? "persistent");
      dropBackgroundCompletion(agent, completionKey);
      if (agent.backgroundCompletionQueue.length > 0) scheduleBackgroundCompletionDrain(agent);
      return;
    }
    agent.backgroundCompletionRejectStreak += 1;
    scheduleBackgroundCompletionRetry(agent);
  };

  const rearmBackgroundCompletion = (agent: ManagedAgent, completionKey = agent.backgroundCompletionInFlight): void => {
    if (!completionKey) return;
    agent.backgroundCompletionKeys.delete(completionKey);
    if (agent.backgroundCompletionInFlight === completionKey) {
      agent.backgroundCompletionInFlight = null;
      agent.backgroundCompletionWakeInputId = null;
    }
    if (!agent.backgroundCompletionQueue.includes(completionKey)) {
      agent.backgroundCompletionQueue.unshift(completionKey);
    }
  };

  const commitBackgroundCompletion = (agent: ManagedAgent): void => {
    const completionKey = agent.backgroundCompletionInFlight;
    if (!completionKey) return;
    if (agent.backgroundCompletionQueue[0] === completionKey) agent.backgroundCompletionQueue.shift();
    agent.backgroundCompletionInFlight = null;
    agent.backgroundCompletionWakeInputId = null;
    agent.backgroundCompletionRejectStreak = 0;
    clearBackgroundCompletionRetryTimer(agent);
  };

  const wakeOnBackgroundCompletion = async (agent: ManagedAgent): Promise<
    { status: "accepted"; inputId: string } | { status: "retry" } | { status: "dropped" }
  > => {
    // Caller already reserved submitting/busy so a concurrent idle drain cannot
    // dequeue another head while ensureSession/prompt yields.
    try {
      const session = await ensureSession(agent);
      if (agent.session !== session || agent.stopped) return { status: "dropped" };
      const input = options.promptBuilder.buildRuntimeInput("wake", crypto.randomUUID(), { wakeReason: "background subagent completed" });
      const result = await session.prompt(input);
      if (agent.session !== session || agent.stopped) return { status: "dropped" };
      if (result.status === "accepted") {
        markSessionStable(agent, session);
        return { status: "accepted", inputId: input.inputId };
      }
      agent.busy = false;
      return { status: "retry" };
    } catch (error) {
      agent.busy = false;
      log("background completion wake failed", error instanceof Error ? error.message : String(error));
      return { status: "retry" };
    }
  };

  const drainBackgroundCompletionQueue = async (agent: ManagedAgent): Promise<void> => {
    if (agent.stopped || agent.busy || agent.turnInProgress || agent.submitting) return;
    if (agent.backgroundCompletionInFlight || !agent.backgroundCompletionQueue.length) return;
    clearBackgroundCompletionRetryTimer(agent);
    const proactive = agent.piProactiveCompaction
      && agent.piProactiveCompactionGeneration === agent.generation
      && agent.piProactiveCompactionSession === agent.session
      ? agent.piProactiveCompaction : null;
    if (proactive && await proactive === "failed") return;
    if (agent.adapter.id === "pi" && agent.piProactiveCompactionFailedGeneration === agent.generation) return;
    if (agent.adapter.id === "pi" && !agent.busy && !agent.turnInProgress && agent.session) {
      const idleGate = proactivelyCompactPiAtIdle(agent, agent.session);
      if (idleGate && await idleGate === "failed") return;
    }
    if (agent.stopped || agent.busy || agent.turnInProgress || agent.submitting) return;
    if (agent.backgroundCompletionInFlight || !agent.backgroundCompletionQueue.length) return;
    agent.submitting = true;
    agent.busy = true;
    const completionKey = agent.backgroundCompletionQueue[0];
    try {
      const outcome = await wakeOnBackgroundCompletion(agent);
      if (outcome.status === "accepted") {
        agent.backgroundCompletionKeys.add(completionKey);
        agent.backgroundCompletionInFlight = completionKey;
        agent.backgroundCompletionWakeInputId = outcome.inputId;
        // Keep the reject streak until the wake turn actually succeeds. An accepted
        // prompt that later terminal-fails must not reset the bounded retry budget.
        clearBackgroundCompletionRetryTimer(agent);
      } else if (outcome.status === "dropped") {
        if (agent.stopped) {
          if (agent.backgroundCompletionQueue[0] === completionKey) agent.backgroundCompletionQueue.shift();
          agent.backgroundCompletionKeys.delete(completionKey);
          clearBackgroundCompletionRetryTimer(agent);
        } else {
          rearmBackgroundCompletion(agent, completionKey);
          agent.busy = false;
        }
      } else {
        agent.busy = false;
        agent.backgroundCompletionRejectStreak += 1;
        // Leave the item queued+deduped. Immediate microtask retries cover a
        // brief reject; after that a bounded timer still drains because Pi will
        // not re-emit the same completion.
        scheduleBackgroundCompletionRetry(agent);
      }
    } finally {
      agent.submitting = false;
    }
  };

  const noteBackgroundCompletion = (agent: ManagedAgent, completionKey: string): void => {
    if (agent.backgroundCompletionKeys.has(completionKey)) return;
    agent.backgroundCompletionKeys.add(completionKey);
    if (!agent.backgroundCompletionQueue.includes(completionKey)) {
      agent.backgroundCompletionQueue.push(completionKey);
    }
    if (!agent.busy && !agent.turnInProgress && !agent.submitting && !agent.backgroundCompletionInFlight) {
      scheduleBackgroundCompletionDrain(agent);
    }
  };

  const scheduleRecreate = (agent: ManagedAgent, reason: string): void => {
    if (agent.stopped || agent.retryTimer || agent.starting || agent.session) return;
    if (agent.recreateAttempts >= retryPolicy.maxAttempts) {
      emit({ type: "agent-status", agentId: agent.config.agentId, status: "error",
        error: `runtime recreation exhausted after ${agent.recreateAttempts} attempts: ${reason}` });
      return;
    }
    const attempt = ++agent.recreateAttempts;
    const delay = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** (attempt - 1));
    emit({ type: "agent-status", agentId: agent.config.agentId, status: "error",
      error: `runtime recreate attempt ${attempt}/${retryPolicy.maxAttempts} in ${delay}ms: ${reason}` });
    agent.retryTimer = setTimeout(() => {
      agent.retryTimer = null;
      if (agent.stopped) return;
      void ensureSession(agent).then(async () => {
        const session = agent.session;
        const proactive = session ? proactivelyCompactPiAtIdle(agent, session) : null;
        if (proactive && await proactive === "failed") return;
        await retryPending(agent);
        if (agent.backgroundCompletionQueue.length > 0) scheduleBackgroundCompletionDrain(agent);
      }).catch((error) => {
        const readiness = error instanceof RuntimePrerequisiteError ? error.readiness
          : classifyRuntimePrerequisite(agent.adapter.id as RuntimeReadiness["runtime"], error);
        agent.readiness = readiness;
        const nextReason = error instanceof Error ? error.message : String(error);
        if (readiness.state === "unavailable") scheduleRecreate(agent, nextReason);
        else {
          agent.disabledReason = nextReason;
          emit({ type: "agent-status", agentId: agent.config.agentId, status: "error", error: nextReason, readiness });
        }
      });
    }, delay);
    agent.retryTimer.unref?.();
  };

  const replaceSession = (agent: ManagedAgent, session: RuntimeSession, reason: string): void => {
    if (agent.session !== session || agent.stopped) return;
    agent.session = null; agent.busy = false; agent.submitting = false; agent.generation += 1;
    rearmBackgroundCompletion(agent);
    agent.recreateReason = reason;
    if (agent.stabilityTimer) clearTimeout(agent.stabilityTimer);
    agent.stabilityTimer = null;
    void session.close(`replace after ${reason}`).catch((error) => log("runtime close after replacement failed", String(error)));
    for (const record of agent.records.values()) if (isActiveDelivery(record.status)) record.status = "pending";
    emitConsumed(agent, persist(agent));
    emit({ type: "agent-status", agentId: agent.config.agentId, status: "error", error: reason });
    scheduleRecreate(agent, reason);
  };

  const recoverConfiguration = (agent: ManagedAgent, session: RuntimeSession, message: string): void => {
    if (agent.session !== session || agent.stopped) return;
    agent.disabledReason = `runtime configuration recovery in progress: ${message}`;
    agent.session = null; agent.busy = false; agent.submitting = false; agent.generation += 1;
    rearmBackgroundCompletion(agent);
    if (agent.stabilityTimer) clearTimeout(agent.stabilityTimer);
    agent.stabilityTimer = null;
    for (const record of agent.records.values()) {
      if (!isActiveDelivery(record.status)) continue;
      setRecord(agent, record, "pending");
      emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
        messageId: record.messageId, status: "deferred", reason: message });
    }
    emit({ type: "agent-status", agentId: agent.config.agentId, status: "error", error: message });
    const recovery = (async () => {
      try {
        await session.close("runtime configuration error");
        const result = agent.adapter.recoverConfigurationError
          ? await agent.adapter.recoverConfigurationError(message)
          : { recovered: false, reason: "runtime adapter does not support automatic configuration recovery" };
        if (agent.stopped) return;
        if (!result.recovered) {
          agent.disabledReason = `${message}\n${result.reason}`;
          emit({ type: "agent-status", agentId: agent.config.agentId, status: "error", error: agent.disabledReason });
          return;
        }
        agent.disabledReason = null;
        agent.recreateAttempts = 0;
        agent.recreateReason = result.reason;
        scheduleRecreate(agent, result.reason);
      } catch (error) {
        if (agent.stopped) return;
        const reason = error instanceof Error ? error.message : String(error);
        agent.disabledReason = `${message}\nCodex update failed: ${reason}`;
        emit({ type: "agent-status", agentId: agent.config.agentId, status: "error", error: agent.disabledReason });
      } finally {
        agent.configurationRecovery = null;
      }
    })();
    agent.configurationRecovery = recovery;
  };

  let recoverContextOverflowInternal: (agentId: string, deliveryKey: string, reason: string, breakerKey?: string) => Promise<RuntimeSessionRecoveryResult>;

  const beginPiManualCompaction = (agent: ManagedAgent, session: RuntimeSession, record: DeliveryRecord, nativeWillRetry = false): void => {
    if (agent.adapter.id !== "pi" || !session.compact || !agent.compactionBreaker) return;
    const existing = agent.compactionMachines.get(record.input.inputId);
    if (existing) {
      existing.agentEnd({ exactOverflow: true, willRetry: nativeWillRetry });
      return;
    }
    const key = `${record.deliveryId}:${record.input.inputId}`;
    const prior = agent.compactionBreaker.get(key);
    if (prior && prior.manualAttempt >= 1 && ["manual_sent", "manual_ambiguous", "manual_failed", "native_failed"].includes(prior.state)) {
      agent.busy = false;
      agent.turnInProgress = false;
      void recoverContextOverflowInternal(agent.config.agentId, key, "validated Pi compaction breaker state after restart", key)
        .catch((error) => log("Pi restart fallback failed", String(error)));
      return;
    }
    const machine = new PiCompactionRecoveryMachine({
      breaker: agent.compactionBreaker, key, messageId: record.messageId, deliveryId: record.deliveryId,
      inputId: record.input.inputId, sessionGeneration: agent.generation,
      onAction: (action) => {
        if (action === "retry_input") {
          machine.retrySubmitted();
          record.status = "pending";
          record.retryable = true;
          record.updatedAt = now();
          persist(agent);
          queueMicrotask(() => { if (!agent.stopped) void submit(agent, record, false); });
        } else if (action === "fresh_session_fallback") {
          agent.busy = false;
          agent.turnInProgress = false;
          const recoveryReason = machine.recordSnapshot.fallbackReason || "Pi compaction recovery fallback";
          // Delivery proof must remain the exact provider-classified context error.
          // Generic Pi recovery text belongs only in the breaker and logs.
          if (record.errorCategory === "context_window" && typeof record.reason === "string") {
            record.retryable = false;
            setRecord(agent, record, "error");
            if (!agent.compactionRecoveryInFlight.has(key)) {
              agent.compactionRecoveryInFlight.add(key);
              void recoverContextOverflowInternal(agent.config.agentId, key, recoveryReason, key)
                .catch((error) => log("Pi context fallback failed", String(error)))
                .finally(() => agent.compactionRecoveryInFlight.delete(key));
            }
          }
        }
      },
    });
    agent.compactionMachines.set(record.input.inputId, machine);
    machine.agentEnd({ exactOverflow: true, willRetry: nativeWillRetry });
    if (nativeWillRetry) return;
    machine.agentSettled();
    const deadline = new Date(Date.now() + compactTimeoutMs).toISOString();
    machine.manualCompactSent(deadline);
    let compactSettled = false;
    const compactTimer = setTimeout(() => {
      if (compactSettled) return;
      compactSettled = true;
      machine.compactTimeout();
    }, compactTimeoutMs);
    compactTimer.unref?.();
    void session.compact().then(() => {
      if (compactSettled) return;
      compactSettled = true;
      clearTimeout(compactTimer);
      machine.compactResponse({ success: true });
    }).catch((error) => {
      if (compactSettled) return;
      compactSettled = true;
      clearTimeout(compactTimer);
      const message = error instanceof Error ? error.message : String(error);
      machine.compactResponse({ success: false, ambiguous: /process exited|process failed|session replaced|protocol/i.test(message) });
    });
  };

  const recoverStalePiCompaction = async (agent: ManagedAgent): Promise<void> => {
    if (!agent.stateStore) return;
    const breaker = agent.compactionBreaker;
    if (!breaker) return;
    const stale = breaker.listNonTerminal().find((candidate) => candidate.state !== "native_succeeded");
    if (!stale) {
      const succeeded = breaker.listNonTerminal().find((candidate) => candidate.state === "native_succeeded");
      if (succeeded) breaker.transition(succeeded.key, {}, "closed");
      return;
    }
    const record = [...agent.records.values()].find((candidate) => candidate.deliveryId === stale.deliveryId
      || candidate.input.inputId === stale.inputId);
    if (!record) return;
    const recoveryReason = stale.fallbackReason || "Pi compaction recovery resumed after restart";
    if (record.errorCategory !== "context_window" || typeof record.reason !== "string") return;
    record.retryable = false;
    setRecord(agent, record, "error");
    breaker.forceFallback(stale.key, recoveryReason);
    agent.busy = false;
    agent.turnInProgress = false;
    await recoverContextOverflowInternal(agent.config.agentId, stale.key, recoveryReason, stale.key);
  };

  const proactivelyCompactPiAtIdle = (agent: ManagedAgent, session: RuntimeSession): Promise<"noop" | "succeeded" | "failed"> | null => {
    if (agent.adapter.id !== "pi" || (session as RuntimeSession & { piPolicyManaged?: boolean }).piPolicyManaged === false
        || !session.getContextUsage || !session.compact) return null;
    if (agent.session !== session || agent.stopped || agent.busy || agent.turnInProgress || agent.submitting || agent.starting
        || agent.compactionRecoveryInFlight.size > 0
        || agent.compactionMachines.size > 0 || agent.piOverflowCompactionFailed.size > 0) return null;
    if (agent.piProactiveCompactionFailedGeneration === agent.generation) return null;
    const generation = agent.generation;
    if (agent.piProactiveCompaction && agent.piProactiveCompactionGeneration === generation
        && agent.piProactiveCompactionSession === session) return agent.piProactiveCompaction;
    const task = (async (): Promise<"noop" | "succeeded"> => {
      const before = await session.getContextUsage!();
      if (!before || agent.session !== session || agent.stopped || agent.busy || agent.turnInProgress || agent.submitting
          || agent.compactionRecoveryInFlight.size > 0 || agent.compactionMachines.size > 0
          || agent.piOverflowCompactionFailed.size > 0) return "noop";
      if (!isPiNativeCompactionRequired(before.tokens, before.contextWindow)) return "noop";
      await session.compact!();
      const after = await session.getContextUsage!();
      if (!after || after.contextWindow !== before.contextWindow || after.tokens >= before.tokens) {
        throw new Error("Pi proactive compaction did not reduce the verified context usage");
      }
      return "succeeded";
    })();
    const tracked = task.catch((error): "failed" => {
      agent.piProactiveCompactionFailedGeneration = generation;
      emit({ type: "agent-status", agentId: agent.config.agentId, status: "error",
        error: "Pi proactive compaction failed; the current session generation is degraded" });
      log("Pi proactive compaction failed", String(error));
      return "failed";
    }).finally(() => {
      if (agent.piProactiveCompaction === tracked) agent.piProactiveCompaction = null;
    });
    agent.piProactiveCompactionGeneration = generation;
    agent.piProactiveCompactionSession = session;
    agent.piProactiveCompaction = tracked;
    return tracked;
  };

  const observe = (agent: ManagedAgent, session: RuntimeSession, event: NormalizedRuntimeEvent): void => {
    if (agent.session !== session) return; // Ignore late output from a replaced child.
    // Keep the trace parent published until authoritative Inbox reconciliation
    // has observed any direct CLI poll completed by this turn.
    if (event.type !== "turn-end") telemetry?.runtimeEvent(agent.config.agentId, event);
    emit({ type: "runtime", agentId: agent.config.agentId, event });
    if (event.type === "runtime-observation") {
      if (event.phase === "compaction_start" && event.reason === "overflow" && event.inputId) {
        const overflowRecord = [...agent.records.values()].find((candidate) => candidate.input.inputId === event.inputId);
        if (overflowRecord && !agent.compactionMachines.has(event.inputId)) beginPiManualCompaction(agent, session, overflowRecord, true);
      }
      const candidates = [...agent.compactionMachines.values()].filter((machine) =>
        machine.recordSnapshot.sessionGeneration === agent.generation
        && (!event.inputId || machine.recordSnapshot.inputId === event.inputId));
      const machines = event.inputId ? candidates : candidates.length === 1 ? candidates : [];
      for (const machine of machines) {
        if (event.phase === "compaction_start" && event.reason === "overflow") machine.compactionStart({ reason: "overflow" });
        if (event.phase === "compaction_end" && event.reason === "manual") {
          machine.compactionEnd({ reason: "manual", success: event.success === true, willRetry: event.willRetry === true });
        }
        if (event.phase === "compaction_end" && event.reason === "overflow") {
          machine.compactionEnd({ reason: "overflow", success: event.success === true, willRetry: event.willRetry === true });
        }
        if (event.phase === "settled") machine.agentSettled();
      }
      if (event.phase === "compaction_end" && event.reason === "overflow" && event.success !== true) {
        for (const record of agent.records.values()) {
          if (isActiveDelivery(record.status)) agent.piOverflowCompactionFailed.add(record.input.inputId);
        }
      }
    }
    if (event.type === "session-init") {
      agent.config.sessionId = event.sessionId;
      emit({ type: "session", agentId: agent.config.agentId, runtime: agent.adapter.id, sessionId: event.sessionId, launchId: agent.launchId,
        ...(event.model ? { model: event.model } : {}), ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}) });
    } else if (event.type === "turn-start") {
      agent.busy = true;
      agent.turnInProgress = true;
      agent.turnHadFailure = false;
      agent.turnHadAuthenticatedOutput = false;
      markSessionStable(agent, session);
      emit({ type: "activity", agentId: agent.config.agentId, activity: "working", activityKind: "working", detailKind: "turn_started" });
    } else if (event.type === "turn-end") {
      for (const [inputId, machine] of agent.compactionMachines) {
        if (machine.recordSnapshot.sessionGeneration !== agent.generation) continue;
        machine.close();
        if (["closed", "fallback_committed"].includes(machine.state)) agent.compactionMachines.delete(inputId);
      }
      const recoveredAuthentication = agent.authFailureActive && agent.turnInProgress
        && agent.turnHadAuthenticatedOutput && !agent.turnHadFailure;
      agent.turnInProgress = false;
      agent.busy = false;
      emit({ type: "activity", agentId: agent.config.agentId, activity: "idle", activityKind: "idle", detailKind: "turn_ended" });
      reconcileAcceptedAtTurnEnd(agent);
      if (agent.backgroundCompletionInFlight) {
        if (agent.turnHadFailure) failBackgroundCompletionWake(agent);
        else commitBackgroundCompletion(agent);
      }
      if (agent.backgroundCompletionQueue.length > 0 && !agent.backgroundCompletionRetryTimer) {
        scheduleBackgroundCompletionDrain(agent);
      }
      telemetry?.runtimeEvent(agent.config.agentId, event);
      if (recoveredAuthentication) {
        agent.authFailureActive = false;
        const prior = agent.readiness;
        agent.readiness = {
          runtime: agent.adapter.id,
          state: "ready",
          ...(prior?.executable ? { executable: prior.executable } : {}),
          ...(prior?.version ? { version: prior.version } : {}),
        };
        emit({ type: "agent-status", agentId: agent.config.agentId, status: "active", readiness: agent.readiness });
      }
      const proactive = proactivelyCompactPiAtIdle(agent, session);
      void (proactive ?? Promise.resolve("noop" as const)).then((outcome) => {
        if (outcome !== "failed") return retryPending(agent);
      });
      queueMicrotask(() => { void scanAndPromoteAcceptedInboxUpdates(agent); });
    } else if (event.type === "runtime-observation") {
      if (event.phase === "completed" && typeof event.completionKey === "string") {
        noteBackgroundCompletion(agent, event.completionKey);
      }
    } else if (event.type === "activity") {
      if (agent.turnInProgress && event.activity !== "internal") agent.turnHadAuthenticatedOutput = true;
      emit({ type: "activity", agentId: agent.config.agentId, activity: event.activity, activityKind: event.activity });
    } else if (event.type === "input-error") {
      if (agent.backgroundCompletionInFlight
        && (!event.inputId || !agent.backgroundCompletionWakeInputId
          || event.inputId === agent.backgroundCompletionWakeInputId)
        && event.willRetry !== true) {
        agent.turnHadFailure = true;
        failBackgroundCompletionWake(agent, event);
      }
      const record = event.inputId
        ? agent.records.get(event.inputId) ?? [...agent.records.values()].find((candidate) => candidate.input.inputId === event.inputId)
        : undefined;
      if (!record || record.status === "consumed" || record.status === "error") return;
      agent.turnHadFailure = true;
      if (agent.adapter.id === "pi" && event.errorCategory === "context_window" && event.willRetry === true && session.compact) {
        beginPiManualCompaction(agent, session, record, true);
        return;
      }
      if (agent.adapter.id === "pi" && event.errorCategory === "context_window" && event.willRetry !== true && session.compact) {
        record.reason = event.message;
        record.retryable = false;
        record.errorCategory = "context_window";
        setRecord(agent, record, "error");
        if (agent.piOverflowCompactionFailed.has(record.input.inputId)) {
          agent.busy = false;
          agent.turnInProgress = false;
          const recoveryKey = `${record.deliveryId}:${record.input.inputId}`;
          if (!agent.compactionRecoveryInFlight.has(recoveryKey)) {
            agent.compactionRecoveryInFlight.add(recoveryKey);
            void recoverContextOverflowInternal(agent.config.agentId, recoveryKey, "native Pi overflow compaction failed", recoveryKey)
              .catch((error) => log("Pi native compaction fallback failed", String(error)))
              .finally(() => agent.compactionRecoveryInFlight.delete(recoveryKey));
          }
          return;
        }
        // Pi emits this terminal error only after agent_settled; release the
        // normal turn reservation before the one authorized recovery action.
        agent.busy = false;
        agent.turnInProgress = false;
        beginPiManualCompaction(agent, session, record);
        return;
      }
      if (event.willRetry) {
        emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
          messageId: record.messageId, status: "deferred", reason: event.message });
        return;
      }
      const submittedWhileBusy = record.input.kind === "inbox_update" || record.input.kind === "inbox-update";
      if (!submittedWhileBusy) agent.busy = false;
      record.reason = event.message;
      record.retryable = event.retryable;
      const classifiedCategory = event.errorCategory ?? classifyStrictProviderError(buildStrictProviderErrorInput({
        message: event.message, errorCategory: event.errorCategory, upstream: event.upstream,
      }));
      if (classifiedCategory) record.errorCategory = classifiedCategory;
      else delete record.errorCategory;
      const finalRecord = setRecord(agent, record, event.retryable ? "pending" : "error");
      if (finalRecord.status !== "consumed") emit({ type: "delivery", agentId: agent.config.agentId,
        deliveryId: record.deliveryId, messageId: record.messageId,
        status: event.retryable ? "deferred" : "error", reason: event.message });
      if (event.errorCategory === "auth" && !event.retryable) {
        const readiness = providerAuthenticationFailureReadiness(agent.adapter.id, event.upstream?.provider);
        agent.authFailureActive = true;
        agent.readiness = {
          ...readiness,
          ...(agent.readiness?.executable ? { executable: agent.readiness.executable } : {}),
          ...(agent.readiness?.version ? { version: agent.readiness.version } : {}),
        };
        emit({ type: "agent-status", agentId: agent.config.agentId, status: "error",
          error: `${agent.readiness.reason} ${agent.readiness.nextAction}`, readiness: agent.readiness });
      }
      if (event.retryable && !agent.busy && !agent.turnInProgress) void retryPending(agent);
    } else if (event.type === "configuration-error") {
      recoverConfiguration(agent, session, event.message);
    } else if (event.type === "error" || event.type === "closed") {
      replaceSession(agent, session, event.type === "error" ? event.message : `runtime closed (${event.code ?? event.signal ?? "unknown"})`);
    }
  };

  const ensureSession = async (agent: ManagedAgent): Promise<RuntimeSession> => {
    if (agent.disabledReason) throw new Error(agent.disabledReason);
    if (agent.session) return agent.session;
    if (agent.starting) return agent.starting;
    const probeEnv = runtimeEnv(agent.config);
    await assertOfficialCliReady(agent.config, probeEnv);
    const readiness = agent.adapter.probe ? await agent.adapter.probe({ agentId: agent.config.agentId,
      workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
      env: { LARKIN_PI_COMMAND: process.env.LARKIN_PI_COMMAND, LARKIN_CODEX_COMMAND: process.env.LARKIN_CODEX_COMMAND,
        LARKIN_CLAUDE_COMMAND: process.env.LARKIN_CLAUDE_COMMAND, ...probeEnv } })
      : { runtime: agent.adapter.id, state: "ready" as const };
    if (!agent.authFailureActive) agent.readiness = readiness;
    if (readiness.state !== "ready") throw new RuntimePrerequisiteError(readiness);
    const standingPrompt = options.promptBuilder.build({
      agentId: agent.config.agentId, name: agent.config.displayName || agent.config.name,
      description: agent.config.description || "", runtime: agent.adapter.id,
      cli: agentCliPromptCapabilities("larkin"),
    });
    const generation = ++agent.generation;
    let completedSession: RuntimeSession | null = null;
    agent.starting = agent.adapter.createSession({
      agentId: agent.config.agentId, model: agent.config.model, reasoningEffort: agent.config.effort || null,
      workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
      resumeSessionId: agent.config.sessionId || null, standingPrompt,
      env: runtimeEnv(agent.config, `${agent.launchId}:${generation}`),
    }).then((session) => {
      completedSession = session;
      if (agent.stopped || generation !== agent.generation) { void session.close("stale creation"); throw new Error("stale runtime session creation"); }
      agent.session = session;
      session.subscribe((event) => observe(agent, session, event));
      if (agent.session !== session) return session;
      if (session.sessionId) {
        agent.config.sessionId = session.sessionId;
        emit({ type: "session", agentId: agent.config.agentId, runtime: agent.adapter.id, sessionId: session.sessionId, launchId: agent.launchId,
          ...(session.effectiveModel ? { model: session.effectiveModel } : {}),
          ...(session.effectiveReasoningEffort ? { reasoningEffort: session.effectiveReasoningEffort } : {}) });
      }
      emit({ type: "agent-status", agentId: agent.config.agentId, status: agent.authFailureActive ? "error" : "active",
        ...(agent.authFailureActive ? { error: `${agent.readiness?.reason} ${agent.readiness?.nextAction}` } : {}),
        readiness: agent.readiness ?? readiness });
      agent.stabilityTimer = setTimeout(() => markSessionStable(agent, session), retryPolicy.stableWindowMs);
      agent.stabilityTimer.unref?.();
      return session;
    }).finally(() => {
      agent.starting = null;
      if (completedSession && !agent.session && !agent.stopped) {
        scheduleRecreate(agent, agent.recreateReason || "runtime closed during session initialization");
      }
    });
    return agent.starting;
  };

  recoverContextOverflowInternal = async (agentId: string, deliveryKey: string, reason: string, breakerKey?: string): Promise<RuntimeSessionRecoveryResult> => {
    const agent = managed.get(agentId);
    if (!agent || agent.stopped) throw new RuntimeSessionRecoveryError("unknown_agent", `unknown runtime Agent: ${agentId}`);
    if (agent.adapter.id !== "pi") throw new RuntimeSessionRecoveryError("recovery_unavailable", "Pi context fallback is unavailable for this runtime");
    const oldSession = agent.session;
    if (!oldSession || agent.busy || agent.submitting || agent.starting) {
      throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} is not idle for Pi context fallback`);
    }
    const record = [...agent.records.values()].find((candidate) =>
      candidate.deliveryId === deliveryKey || candidate.input.inputId === deliveryKey || `${candidate.deliveryId}:${candidate.input.inputId}` === deliveryKey);
    if (!record) throw new RuntimeSessionRecoveryError("recovery_refused", "Pi context fallback delivery identity is unavailable");
    const probeEnv = runtimeEnv(agent.config, `${agent.launchId}:pi-context-fallback`);
    await assertOfficialCliReady(agent.config, probeEnv);
    const readiness = agent.adapter.probe ? await agent.adapter.probe({ agentId: agent.config.agentId,
      workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir, env: probeEnv }) : { runtime: "pi" as const, state: "ready" as const };
    if (readiness.state !== "ready") throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "Pi context fallback readiness failed");
    const standingPrompt = options.promptBuilder.build({
      agentId: agent.config.agentId, name: agent.config.displayName || agent.config.name,
      description: agent.config.description || "", runtime: agent.adapter.id, cli: agentCliPromptCapabilities("larkin"),
    });
    let fresh: RuntimeSession;
    try {
      fresh = await agent.adapter.createSession({ agentId: agent.config.agentId, model: agent.config.model,
        reasoningEffort: agent.config.effort || null, workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
        resumeSessionId: null, standingPrompt, env: probeEnv });
    } catch {
      throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "Pi fresh fallback session could not be staged");
    }
    if (agent.session !== oldSession || agent.busy || agent.submitting || agent.starting || agent.stopped) {
      await fresh.close("Pi context fallback commit precondition changed").catch(() => {});
      throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} changed during Pi context fallback`);
    }
    let unsubscribeFresh: (() => void) | null = null;
    try { unsubscribeFresh = fresh.subscribe((next) => observe(agent, fresh, next)); }
    catch {
      await fresh.close("Pi context fallback subscription failed").catch(() => {});
      throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "Pi context fallback subscription failed");
    }
    const oldSessionId = oldSession.sessionId;
    const oldGeneration = agent.generation;
    const oldLaunchId = agent.launchId;
    const oldConfigSessionId = agent.config.sessionId;
    const oldReadiness = agent.readiness;
    const oldDisabledReason = agent.disabledReason;
    const oldRecord = { ...record, input: { ...record.input } };
    let durableRollback: (() => void) | null = null;
    let rearmedCount = 1;
    let remainingPendingCount = 1;
    const commitSwap = (messageIds: readonly string[], rollback?: () => void): void => {
      if (agent.session !== oldSession || agent.busy || agent.submitting || agent.starting || agent.stopped) {
        throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} changed during Pi context fallback`);
      }
      durableRollback = rollback ?? null;
      if (breakerKey && agent.compactionBreaker) agent.compactionBreaker.forceFallbackInTransaction(breakerKey, reason);
      agent.generation += 1;
      agent.launchId = crypto.randomUUID();
      agent.config.sessionId = null;
      agent.session = fresh;
      agent.readiness = readiness;
      agent.disabledReason = null;
      for (const candidate of agent.records.values()) {
        if (!messageIds.includes(candidate.messageId)) continue;
        candidate.status = "pending"; candidate.retryable = true; candidate.updatedAt = now();
      }
    };
    try {
      if (agent.stateStore?.rearmContextOverflow) {
        const rearmed = agent.stateStore.rearmContextOverflow((messageIds, rollback) => commitSwap(messageIds, rollback), {
          messageId: record.messageId, deliveryId: record.deliveryId, inputId: record.input.inputId,
        });
        rearmedCount = rearmed.rearmedCount;
        remainingPendingCount = rearmed.remainingPendingCount;
      } else {
        commitSwap([record.messageId]);
        persist(agent);
      }
    } catch (error) {
      try { const rollback = durableRollback as (() => void) | null; if (rollback) rollback(); } catch { /* preserve primary error */ }
      agent.generation = oldGeneration;
      agent.launchId = oldLaunchId;
      agent.config.sessionId = oldConfigSessionId;
      agent.session = oldSession;
      agent.readiness = oldReadiness;
      agent.disabledReason = oldDisabledReason;
      Object.assign(record, oldRecord);
      try { unsubscribeFresh?.(); } catch { /* preserve primary failure */ }
      await fresh.close("Pi context fallback rolled back").catch(() => {});
      throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", error instanceof Error ? error.message : "Pi context fallback commit failed");
    }
    if (fresh.sessionId) {
      agent.config.sessionId = fresh.sessionId;
      emit({ type: "session", agentId, runtime: agent.adapter.id, sessionId: fresh.sessionId, launchId: agent.launchId,
        ...(fresh.effectiveModel ? { model: fresh.effectiveModel } : {}),
        ...(fresh.effectiveReasoningEffort ? { reasoningEffort: fresh.effectiveReasoningEffort } : {}) });
    }
    emit({ type: "agent-status", agentId, status: "active", readiness });
    await oldSession.close("Pi context fallback committed").catch((error) => log("previous Pi session close after fallback failed", String(error)));
    const proactive = proactivelyCompactPiAtIdle(agent, fresh);
    void (proactive ?? Promise.resolve("noop" as const)).then((outcome) => {
      if (outcome !== "failed") return retryPending(agent);
    });
    return { generationChanged: true, sessionChanged: oldSessionId !== fresh.sessionId, turns: 0,
      runtimeReady: true, pendingCount: remainingPendingCount, rearmedCount,
      replayStatus: remainingPendingCount > 0 ? "pending" : "consumed", sessionId: fresh.sessionId };
  };

  return {
    async probe(config): Promise<RuntimeReadiness> {
      const adapter = options.adapterFor(config.runtime);
      const env = runtimeEnv(config);
      await assertOfficialCliReady(config, env);
      return adapter.probe ? adapter.probe({ agentId: config.agentId, workspaceDir: config.workspaceDir, stateDir: config.stateDir,
        env: { LARKIN_PI_COMMAND: process.env.LARKIN_PI_COMMAND, LARKIN_CODEX_COMMAND: process.env.LARKIN_CODEX_COMMAND,
          LARKIN_CLAUDE_COMMAND: process.env.LARKIN_CLAUDE_COMMAND, ...env } })
        : { runtime: adapter.id, state: "ready" };
    },
    async stage(config): Promise<StagedRuntimeCandidate> {
      const previous = managed.get(config.agentId);
      if (!previous) throw new Error(`cannot stage unknown runtime Agent: ${config.agentId}`);
      if (previous.busy || previous.submitting || previous.starting) {
        throw new Error(`Agent ${config.agentId} is not idle for runtime staging`);
      }
      const adapter = options.adapterFor(config.runtime);
      const stageEnv = runtimeEnv(config, `${crypto.randomUUID()}:staged`);
      await assertOfficialCliReady(config, stageEnv);
      const readiness = adapter.probe ? await adapter.probe({ agentId: config.agentId, workspaceDir: config.workspaceDir, stateDir: config.stateDir,
        env: { LARKIN_PI_COMMAND: process.env.LARKIN_PI_COMMAND, LARKIN_CODEX_COMMAND: process.env.LARKIN_CODEX_COMMAND,
          LARKIN_CLAUDE_COMMAND: process.env.LARKIN_CLAUDE_COMMAND, ...stageEnv } })
        : { runtime: adapter.id, state: "ready" as const };
      if (readiness.state !== "ready") throw new RuntimePrerequisiteError(readiness);
      const standingPrompt = options.promptBuilder.build({
        agentId: config.agentId, name: config.displayName || config.name,
        description: config.description || "", runtime: adapter.id,
        cli: agentCliPromptCapabilities("larkin"),
      });
      const session = await adapter.createSession({
        agentId: config.agentId, model: config.model, reasoningEffort: config.effort || null,
        workspaceDir: config.workspaceDir, stateDir: config.stateDir,
        resumeSessionId: config.sessionId || null, standingPrompt,
        env: stageEnv,
      });
      let state: "staged" | "committed" | "rolled_back" = "staged";
      const rollback = async (reason: string): Promise<void> => {
        if (state !== "staged") return;
        state = "rolled_back";
        await session.close(reason);
      };
      return {
        readiness,
        async commit(): Promise<void> {
          if (state !== "staged") throw new Error(`runtime candidate is ${state}`);
          const current = managed.get(config.agentId);
          if (current !== previous || previous.busy || previous.submitting || previous.starting) {
            await rollback("runtime candidate commit precondition changed");
            throw new Error(`Agent ${config.agentId} changed or became busy during runtime staging`);
          }
          state = "committed";
          previous.stopped = true;
          previous.generation += 1;
          if (previous.poller) clearInterval(previous.poller);
          if (previous.retryTimer) clearTimeout(previous.retryTimer);
          if (previous.stabilityTimer) clearTimeout(previous.stabilityTimer);
          if (previous.backgroundCompletionRetryTimer) clearTimeout(previous.backgroundCompletionRetryTimer);
          const candidate: ManagedAgent = {
            ...previous, config, adapter, session, launchId: crypto.randomUUID(), busy: false, submitting: false,
            starting: null, retryAfterSubmit: false, generation: 0, poller: null, retryTimer: null,
            recreateAttempts: 0, stabilityTimer: null, recreateReason: null, stopped: false,
            backgroundCompletionRetryTimer: null,
            disabledReason: null, configurationRecovery: null,
            readiness: previous.authFailureActive ? previous.readiness : readiness,
          };
          managed.set(config.agentId, candidate);
          session.subscribe((event) => observe(candidate, session, event));
          if (session.sessionId) {
            candidate.config.sessionId = session.sessionId;
            emit({ type: "session", agentId: config.agentId, runtime: adapter.id, sessionId: session.sessionId,
              launchId: candidate.launchId, ...(session.effectiveModel ? { model: session.effectiveModel } : {}),
              ...(session.effectiveReasoningEffort ? { reasoningEffort: session.effectiveReasoningEffort } : {}) });
          }
          candidate.poller = setInterval(() => reconcileExternalConsumption(candidate), 250);
          candidate.poller.unref?.();
          if (!candidate.authFailureActive) {
            emit({ type: "agent-status", agentId: config.agentId, status: "active", readiness: candidate.readiness ?? readiness });
          }
          await previous.session?.close("runtime candidate committed")
            .catch((error) => log("previous runtime close after candidate commit failed", String(error)));
        },
        rollback,
      };
    },
    isBusy(agentId): boolean { const agent = managed.get(agentId); return Boolean(agent?.busy || agent?.submitting || agent?.starting); },
    async scanPendingInboxUpdates(agentId): Promise<void> {
      const agents = agentId ? [managed.get(agentId)] : [...managed.values()];
      for (const agent of agents) {
        if (!agent || agent.stopped) continue;
        await scanAndPromoteAcceptedInboxUpdates(agent);
      }
    },
    async resetSession(agentId): Promise<RuntimeSessionResetResult> {
      const agent = managed.get(agentId);
      if (!agent || agent.stopped) throw new RuntimeSessionResetError("unknown_agent", `unknown runtime Agent: ${agentId}`);
      if (agent.busy || agent.turnInProgress || agent.submitting || agent.starting) {
        throw new RuntimeSessionResetError("agent_busy", `Agent ${agentId} is not idle`);
      }
      const countPending = (): number => agent.stateStore
        ? agent.stateStore.withInboxTransaction(() => agent.stateStore!.readNdjson?.<Record<string, unknown>>("inbox").length ?? 0)
        : [...agent.records.values()].filter((record) => isActiveDelivery(record.status)).length;
      const pendingCount = countPending();
      if (pendingCount > 0) throw new RuntimeSessionResetError("inbox_backlog", `Agent ${agentId} has unconsumed Inbox backlog`, pendingCount);
      const oldSession = agent.session;
      if (!oldSession) throw new RuntimeSessionResetError("agent_busy", `Agent ${agentId} Runtime session is unavailable`);
      const oldSessionId = oldSession.sessionId;
      const probeEnv = runtimeEnv(agent.config, `${agent.launchId}:reset`);
      await assertOfficialCliReady(agent.config, probeEnv);
      const readiness = agent.adapter.probe ? await agent.adapter.probe({ agentId: agent.config.agentId,
        workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
        env: { LARKIN_PI_COMMAND: process.env.LARKIN_PI_COMMAND, LARKIN_CODEX_COMMAND: process.env.LARKIN_CODEX_COMMAND,
          LARKIN_CLAUDE_COMMAND: process.env.LARKIN_CLAUDE_COMMAND, ...probeEnv } })
        : { runtime: agent.adapter.id, state: "ready" as const };
      if (readiness.state !== "ready") throw new RuntimePrerequisiteError(readiness);
      const standingPrompt = options.promptBuilder.build({
        agentId: agent.config.agentId, name: agent.config.displayName || agent.config.name,
        description: agent.config.description || "", runtime: agent.adapter.id,
        cli: agentCliPromptCapabilities("larkin"),
      });
      const create = agent.adapter.createSession({
        agentId: agent.config.agentId, model: agent.config.model, reasoningEffort: agent.config.effort || null,
        workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
        resumeSessionId: null, standingPrompt, env: probeEnv,
      });
      agent.starting = create;
      let fresh: RuntimeSession;
      try { fresh = await create; }
      finally { if (agent.starting === create) agent.starting = null; }
      const commit = (): void => {
        if (agent.session !== oldSession || agent.busy || agent.turnInProgress || agent.submitting || agent.stopped) {
          throw new RuntimeSessionResetError("agent_busy", `Agent ${agentId} changed during reset`);
        }
        const pendingAfterCreate = agent.stateStore?.readNdjson?.<Record<string, unknown>>("inbox").length
          ?? [...agent.records.values()].filter((record) => isActiveDelivery(record.status)).length;
        if (pendingAfterCreate > 0) {
          throw new RuntimeSessionResetError("inbox_backlog", `Agent ${agentId} received Inbox backlog during reset`, pendingAfterCreate);
        }
        agent.generation += 1;
        agent.launchId = crypto.randomUUID();
        agent.config.sessionId = null;
        agent.session = fresh;
        agent.readiness = readiness;
        agent.disabledReason = null;
      };
      try {
        if (agent.stateStore) agent.stateStore.withInboxTransaction(commit);
        else commit();
      } catch (error) {
        await fresh.close("fresh session reset precondition changed");
        throw error;
      }
      fresh.subscribe((event) => observe(agent, fresh, event));
      if (fresh.sessionId) {
        agent.config.sessionId = fresh.sessionId;
        emit({ type: "session", agentId, runtime: agent.adapter.id, sessionId: fresh.sessionId, launchId: agent.launchId,
          ...(fresh.effectiveModel ? { model: fresh.effectiveModel } : {}),
          ...(fresh.effectiveReasoningEffort ? { reasoningEffort: fresh.effectiveReasoningEffort } : {}) });
      }
      emit({ type: "agent-status", agentId, status: "active", readiness });
      await oldSession.close("fresh session reset committed")
        .catch((error) => log("previous runtime close after fresh reset failed", String(error)));
      return { generationChanged: true, sessionChanged: oldSessionId !== fresh.sessionId, turns: 0,
        runtimeReady: true, pendingCount: 0, sessionId: fresh.sessionId };
    },
    async recoverSession(agentId, reason): Promise<RuntimeSessionRecoveryResult> {
      if (reason !== "context-overflow") throw new RuntimeSessionRecoveryError("recovery_refused", "unsupported recovery reason");
      const agent = managed.get(agentId);
      if (agent && agent.adapter.id !== "pi") throw new RuntimeSessionRecoveryError("recovery_unavailable", "context-overflow recovery is available only for Pi Runtime");
      if (!agent || agent.stopped) throw new RuntimeSessionRecoveryError("unknown_agent", `unknown runtime Agent: ${agentId}`);
      if (!agent.stateStore?.rearmContextOverflow) {
        throw new RuntimeSessionRecoveryError("recovery_unavailable", "canonical Inbox recovery is unavailable");
      }
      if (agent.busy || agent.turnInProgress || agent.submitting || agent.starting) {
        throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} is not idle`);
      }
      const oldSession = agent.session;
      if (!oldSession) throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} Runtime session is unavailable`);
      const oldSessionId = oldSession.sessionId;
      if (agent.stateStore.readNdjson) {
        const pendingRows = agent.stateStore.withInboxTransaction(() => agent.stateStore!.readNdjson!("inbox"));
        if (pendingRows.length === 0) {
          throw new RuntimeSessionRecoveryError("recovery_refused", "context-window recovery has no retained Inbox backlog");
        }
        const messageIds = new Set(pendingRows.flatMap((row) => {
          const messageId = row && typeof row === "object" && !Array.isArray(row)
            ? (row as { message_id?: unknown }).message_id : undefined;
          return typeof messageId === "string" && messageId ? [messageId] : [];
        }));
        const persisted = agent.stateStore.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] });
        if (Array.isArray(persisted.records) && persisted.records.some((record) => messageIds.has(record.messageId) && record.status !== "error")) {
          throw new RuntimeSessionRecoveryError("recovery_refused", "context-window recovery is already staged or completed");
        }
      }
      const probeEnv = runtimeEnv(agent.config, `${agent.launchId}:context-overflow-recovery`);
      let readiness: RuntimeReadiness;
      try {
        await assertOfficialCliReady(agent.config, probeEnv);
        readiness = agent.adapter.probe ? await agent.adapter.probe({ agentId: agent.config.agentId,
          workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
          env: { LARKIN_PI_COMMAND: process.env.LARKIN_PI_COMMAND, LARKIN_CODEX_COMMAND: process.env.LARKIN_CODEX_COMMAND,
            LARKIN_CLAUDE_COMMAND: process.env.LARKIN_CLAUDE_COMMAND, ...probeEnv } })
          : { runtime: agent.adapter.id, state: "ready" as const };
      } catch (error) {
        if (error instanceof RuntimePrerequisiteError) throw error;
        throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "Runtime readiness probe failed");
      }
      if (readiness.state !== "ready") throw new RuntimePrerequisiteError(readiness);
      const standingPrompt = options.promptBuilder.build({
        agentId: agent.config.agentId, name: agent.config.displayName || agent.config.name,
        description: agent.config.description || "", runtime: agent.adapter.id,
        cli: agentCliPromptCapabilities("larkin"),
      });
      let fresh: RuntimeSession;
      try {
        fresh = await agent.adapter.createSession({
          agentId: agent.config.agentId, model: agent.config.model, reasoningEffort: agent.config.effort || null,
          workspaceDir: agent.config.workspaceDir, stateDir: agent.config.stateDir,
          resumeSessionId: null, standingPrompt, env: probeEnv,
        });
      } catch {
        throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "fresh Runtime session could not be staged");
      }
      let unsubscribeFresh: (() => void) | null = null;
      try { unsubscribeFresh = fresh.subscribe((event) => observe(agent, fresh, event)); }
      catch {
        await fresh.close("context-window recovery subscription failed").catch(() => {});
        throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "fresh Runtime session subscription failed");
      }
      const oldGeneration = agent.generation;
      const oldLaunchId = agent.launchId;
      const oldConfigSessionId = agent.config.sessionId;
      const oldReadiness = agent.readiness;
      const oldDisabledReason = agent.disabledReason;
      const oldRecords = new Map([...agent.records.entries()].map(([id, record]) => [id, { ...record, input: { ...record.input } }] as const));
      const cleanupFresh = async (reason: string): Promise<void> => {
        const unsubscribe = unsubscribeFresh;
        unsubscribeFresh = null;
        try { unsubscribe?.(); } catch { /* close still owns staged-session cleanup */ }
        await fresh.close(reason).catch(() => {});
      };
      const restoreRuntime = (): void => {
        agent.session = oldSession;
        agent.generation = oldGeneration;
        agent.launchId = oldLaunchId;
        agent.config.sessionId = oldConfigSessionId;
        agent.readiness = oldReadiness;
        agent.disabledReason = oldDisabledReason;
        agent.records = new Map(oldRecords);
        agent.byMessage = new Map([...oldRecords.values()].map((record) => [record.messageId, record.deliveryId]));
      };
      let recoveryProjectionEmitted = false;
      const compensateProjection = (): void => {
        if (!recoveryProjectionEmitted) return;
        try { emit({ type: "session", agentId, runtime: agent.adapter.id, sessionId: oldSessionId, launchId: oldLaunchId }); }
        catch { /* preserve the original listener failure */ }
        try { emit({ type: "agent-status", agentId, status: "active", ...(oldReadiness ? { readiness: oldReadiness } : {}) }); }
        catch { /* preserve the original listener failure */ }
      };
      let durableRollback: (() => void) | null = null;
      try {
        const rearmed = agent.stateStore.rearmContextOverflow((messageIds, rollback) => {
          // This callback runs under the canonical Inbox lock. All potentially
          // racing checks above are synchronous from this process, while the
          // state-store method rechecks every row and delivery on disk.
          if (agent.session !== oldSession || agent.busy || agent.turnInProgress || agent.submitting || agent.starting || agent.stopped) {
            throw new RuntimeSessionRecoveryError("agent_busy", `Agent ${agentId} changed during recovery`);
          }
          durableRollback = rollback;
          agent.generation += 1;
          agent.launchId = crypto.randomUUID();
          agent.config.sessionId = null;
          agent.session = fresh;
          agent.readiness = readiness;
          agent.disabledReason = null;
          for (const record of agent.records.values()) {
            if (!messageIds.includes(record.messageId)) continue;
            record.status = "pending";
            record.retryable = true;
            record.updatedAt = now();
          }
        });
        recoveryProjectionEmitted = true;
        if (fresh.sessionId) {
          agent.config.sessionId = fresh.sessionId;
          emit({ type: "session", agentId, runtime: agent.adapter.id, sessionId: fresh.sessionId, launchId: agent.launchId,
            ...(fresh.effectiveModel ? { model: fresh.effectiveModel } : {}),
            ...(fresh.effectiveReasoningEffort ? { reasoningEffort: fresh.effectiveReasoningEffort } : {}) });
        }
        emit({ type: "agent-status", agentId, status: "active", readiness });
        durableRollback = null;
        await oldSession.close("context-window recovery committed")
          .catch((error) => log("previous runtime close after context-window recovery failed", String(error)));
        const proactive = proactivelyCompactPiAtIdle(agent, fresh);
        void (proactive ?? Promise.resolve("noop" as const)).then((outcome) => {
          if (outcome !== "failed") return retryPending(agent);
        });
        return { generationChanged: true, sessionChanged: oldSessionId !== fresh.sessionId, turns: 0,
          runtimeReady: true, pendingCount: rearmed.remainingPendingCount, rearmedCount: rearmed.rearmedCount,
          replayStatus: rearmed.remainingPendingCount > 0 ? "pending" : "consumed", sessionId: fresh.sessionId };
      } catch (error) {
        try { const rollback = durableRollback as (() => void) | null; if (rollback) rollback(); } catch { /* preserve the original failure */ }
        restoreRuntime();
        compensateProjection();
        await cleanupFresh("context-window recovery not committed");
        if (error instanceof RuntimeSessionRecoveryError) throw error;
        if (typeof (error as { code?: unknown }).code === "string") {
          throw new RuntimeSessionRecoveryError("recovery_refused", error instanceof Error ? error.message : "context-window recovery was refused");
        }
        throw new RuntimeSessionRecoveryError("recovery_staged_not_committed", "context-window recovery was not committed");
      }
    },
    async recoverContextOverflow(agentId, deliveryKey, reason): Promise<RuntimeSessionRecoveryResult> {
      return recoverContextOverflowInternal(agentId, deliveryKey, reason);
    },
    async start(configs): Promise<void> {
      let activeCount = 0;
      let recoveringCount = 0;
      const startupFailures: string[] = [];
      // Agents start concurrently: each Agent's runtime session is independent,
      // and serial startup multiplied every per-Agent handshake (login-shell
      // probe + runtime RPC discovery) by the Agent count.
      const startups = configs.map(async (config) => {
        if (managed.has(config.agentId)) { activeCount += 1; return; }
        const stateStore = options.stateStoreFor?.(config.agentId);
        const persisted = stateStore
          ? stateStore.withInboxTransaction(() => {
            const deliveryFile = stateStore.readJson<DeliveryFile>("runtimeDeliveries", { version: 1, records: [] });
            if (!stateStore.readNdjson) return deliveryFile;
            let inboxRows: Record<string, unknown>[];
            try { inboxRows = stateStore.readNdjson<Record<string, unknown>>("inbox"); }
            catch { return deliveryFile; }
            const inboxIds = new Set(inboxRows.flatMap((row) =>
              typeof row?.message_id === "string" ? [row.message_id] : []));
            let changed = false;
            const records = deliveryFile.records.map((record) => {
              const synthetic = /^(?:redeliver_|rem_|interaction_)/.test(record.messageId);
              if (!synthetic || !isActiveDelivery(record.status) || inboxIds.has(record.messageId)) return record;
              changed = true;
              return { ...record, status: "consumed" as const, updatedAt: now() };
            });
            const migrated = changed ? { ...deliveryFile, records } : deliveryFile;
            if (changed) stateStore.writeJson("runtimeDeliveries", migrated);
            return migrated;
          })
          : readDeliveryFile(config.stateDir ? path.join(config.stateDir, "runtime-deliveries.json") : null);
        const agent: ManagedAgent = { config, adapter: options.adapterFor(config.runtime), session: null,
          launchId: crypto.randomUUID(), busy: false, submitting: false, starting: null, retryAfterSubmit: false,
          retryPendingInFlight: null,
          records: new Map(persisted.records.map((record) => [record.deliveryId, record])),
          byMessage: new Map(persisted.records.map((record) => [record.messageId, record.deliveryId])),
          generation: 0, poller: null, retryTimer: null, recreateAttempts: 0,
          stabilityTimer: null, recreateReason: null, stopped: false, disabledReason: null,
          configurationRecovery: null, stateStore,
          compactionBreaker: config.runtime === "pi" && stateStore
            ? new PiCompactionBreaker(config.stateDir ?? path.join(config.workspaceDir, ".larkin", "agents", config.agentId), {
              withLock: <T>(operation: () => T): T => stateStore.withInboxTransaction(operation),
            }) : undefined,
          compactionMachines: new Map(), compactionRecoveryInFlight: new Set(), piOverflowCompactionFailed: new Set(),
          piProactiveCompaction: null, piProactiveCompactionGeneration: null, piProactiveCompactionSession: null,
          piProactiveCompactionFailedGeneration: null, readiness: null,
          turnInProgress: false, turnHadFailure: false, turnHadAuthenticatedOutput: false, authFailureActive: false,
          promotedInboxUpdateIds: new Set(),
          backgroundCompletionQueue: [], backgroundCompletionKeys: new Set(),
          backgroundCompletionInFlight: null, backgroundCompletionWakeInputId: null,
          backgroundCompletionRejectStreak: 0, backgroundCompletionRetryTimer: null };
        const startupConsumed: DeliveryRecord[] = [];
        const startupQuarantined: Array<{ record: DeliveryRecord; code: ReplayFailureCode }> = [];
        for (const record of agent.records.values()) {
          const existingQuarantine = replayFailureCodeOf(record);
          if (existingQuarantine) {
            startupQuarantined.push({ record, code: existingQuarantine });
            continue;
          }
          if (!isActiveDelivery(record.status)) continue;
          record.status = "pending";
          const prepared = prepareRecordInput(agent, record, false);
          if (prepared.status === "consumed") {
            record.status = "consumed";
            record.updatedAt = now();
            startupConsumed.push(record);
          } else if (prepared.status === "error") {
            record.status = "error";
            record.updatedAt = now();
            scrubQuarantinedInput(record, prepared.reason);
            record.reason = prepared.reason;
            record.retryable = false;
            startupQuarantined.push({ record, code: prepared.code });
          }
        }
        managed.set(config.agentId, agent);
        emitConsumed(agent, [...startupConsumed, ...persist(agent)]);
        try {
          await ensureSession(agent);
          await recoverStalePiCompaction(agent);
          const startupSession = agent.session;
          const proactive = startupSession ? proactivelyCompactPiAtIdle(agent, startupSession) : null;
          const proactiveOutcome = proactive ? await proactive : "noop" as const;
          activeCount += 1;
          if (proactiveOutcome !== "failed") await retryPending(agent);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const transient = error instanceof RuntimePrerequisiteError && error.readiness.state === "unavailable";
          agent.disabledReason = transient ? null : reason;
          if (transient) { recoveringCount += 1; scheduleRecreate(agent, reason); }
          startupFailures.push(`${config.agentId}: ${reason}`);
          emit({ type: "agent-status", agentId: config.agentId, status: "error", error: reason,
            ...(error instanceof RuntimePrerequisiteError ? { readiness: error.readiness } : {}) });
        }
        const visibleQuarantines = startupQuarantined.filter(({ record }) => agent.records.get(record.deliveryId)?.status === "error");
        for (const { record, code } of visibleQuarantines) emit({ type: "delivery", agentId: config.agentId,
          deliveryId: record.deliveryId, messageId: record.messageId, status: "error", reason: replayFailureReason(code) });
        if (visibleQuarantines.length) emit({ type: "agent-status", agentId: config.agentId, status: "error",
          error: `${visibleQuarantines.length} Runtime delivery record(s) quarantined; canonical Inbox recovery is required` });
        agent.poller = setInterval(() => reconcileExternalConsumption(agent), 250); agent.poller.unref?.();
      });
      await Promise.all(startups);
      if (configs.length > 0 && activeCount === 0 && recoveringCount === 0) {
        throw new Error(`No runtime Agent started: ${startupFailures.join("; ")}`);
      }
    },
    async deliver(agentId, envelope): Promise<DeliveryReceipt> {
      const messageId = String(envelope.message_id || envelope.seq || crypto.randomUUID());
      const agent = managed.get(agentId);
      if (!agent) { telemetry?.delivery(agentId, messageId, "error"); throw new Error(`unknown runtime Agent: ${agentId}`); }
      let target: string;
      try {
        target = targetKeyOfInboxEnvelope(envelope);
      } catch (error) {
        const reason = `Inbox target derivation failed: ${error instanceof Error ? error.message : String(error)}`;
        const deliveryId = `invalid-target-${crypto.createHash("sha256").update(`${agentId}\0${messageId}`).digest("hex").slice(0, 24)}`;
        telemetry?.delivery(agentId, messageId, "error");
        emit({ type: "delivery", agentId, deliveryId, messageId, status: "error", reason });
        return { status: "error", deliveryId, reason, retryable: false };
      }
      reconcileExternalConsumption(agent);
      const existingId = agent.byMessage.get(messageId);
      if (existingId) {
        const existing = agent.records.get(existingId);
        if (existing?.status === "error") {
          if (existing.target && existing.target !== target) return quarantineRecord(agent, existing, "delivery_target_conflict");
          existing.target = target;
          if (typeof envelope.wake_reason === "string" && envelope.wake_reason) existing.wakeReason = envelope.wake_reason;
          else delete existing.wakeReason;
          const priorAttempt = existing.input && Number.isSafeInteger(existing.input.attempt) ? existing.input.attempt : 0;
          existing.input = existing.input && typeof existing.input === "object"
            ? { ...existing.input, attempt: priorAttempt + 1 }
            : { inputId: existing.deliveryId, deliveryId: existing.deliveryId, kind: "wake", text: "", attempt: priorAttempt + 1 };
          delete existing.reason;
          delete existing.retryable;
          agent.promotedInboxUpdateIds.delete(existing.deliveryId);
          setRecord(agent, existing, "pending");
          const receipt = await (telemetry?.phase(messageId, "runtime.deliver", SpanKind.PRODUCER,
            () => submit(agent, existing, agent.busy || agent.submitting)) ?? submit(agent, existing, agent.busy || agent.submitting));
          telemetry?.delivery(agentId, messageId, receipt.status);
          reconcileAbsentCanonical(agent, agent.records.get(existingId) ?? existing);
          return receipt;
        }
        if (existing) reconcileAbsentCanonical(agent, existing);
        telemetry?.delivery(agentId, messageId, "duplicate");
        return { status: "duplicate", deliveryId: existingId };
      }
      if ([...agent.records.values()].filter((record) => isActiveDelivery(record.status)).length >= MAX_DELIVERIES) {
        const deliveryId = `overflow-${crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
        telemetry?.delivery(agentId, messageId, "deferred");
        return { status: "deferred", deliveryId, reason: `runtime delivery backlog limit ${MAX_DELIVERIES} reached` };
      }
      const deliveryId = crypto.randomUUID();
      const busy = agent.busy || agent.submitting;
      const wakeReason = typeof envelope.wake_reason === "string" ? envelope.wake_reason : undefined;
      const input: RuntimeInput = { inputId: deliveryId, deliveryId, kind: busy ? "inbox_update" : "wake",
        text: options.promptBuilder.buildInboxNotice({ busy, count: 1, deliveryId, target,
          ...(wakeReason ? { wakeReason } : {}) }), attempt: 0 };
      const record: DeliveryRecord = { deliveryId, messageId, status: "pending", input, target,
        ...(wakeReason ? { wakeReason } : {}), updatedAt: now() };
      agent.records.set(deliveryId, record); agent.byMessage.set(messageId, deliveryId); persist(agent);
      if (agent.disabledReason) {
        reconcileAbsentCanonical(agent, record);
        telemetry?.delivery(agentId, messageId, "deferred");
        return { status: "deferred", deliveryId, reason: agent.disabledReason };
      }
      const receipt = await (telemetry?.phase(messageId, "runtime.deliver", SpanKind.PRODUCER,
        () => submit(agent, record, busy)) ?? submit(agent, record, busy));
      telemetry?.delivery(agentId, messageId, receipt.status);
      reconcileAbsentCanonical(agent, agent.records.get(deliveryId) ?? record);
      return receipt;
    },
    async stop(agentId, reason): Promise<void> {
      const agent = managed.get(agentId); if (!agent) return; agent.stopped = true;
      if (agent.poller) clearInterval(agent.poller);
      if (agent.retryTimer) clearTimeout(agent.retryTimer);
      if (agent.stabilityTimer) clearTimeout(agent.stabilityTimer);
      if (agent.backgroundCompletionRetryTimer) clearTimeout(agent.backgroundCompletionRetryTimer);
      if (agent.busy) await agent.session?.cancel(reason);
      await agent.session?.close(reason); managed.delete(agentId);
      emit({ type: "agent-status", agentId, status: "inactive" });
    },
    async shutdown(reason): Promise<void> { await Promise.allSettled([...managed.keys()].map((id) => this.stop(id, reason))); },
    subscribe(listener): () => void { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
