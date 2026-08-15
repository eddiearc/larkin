import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentCliPromptCapabilities } from "../agent/agent-cli-capabilities.js";
import { isCanonicalInboxTarget, targetKeyOfInboxEnvelope } from "../agent/inbox-projection.js";
import type { InboxDeliverySourceResolution } from "../agent/agent-state-store.js";
import { SpanKind } from "@opentelemetry/api";
import type { ContextPromptBuilder } from "../agent/context-prompt.js";
import type {
  NormalizedRuntimeEvent, RuntimeAdapter, RuntimeInput, RuntimeInputResult, RuntimeSession,
} from "./runtime-contracts.js";
import {
  classifyRuntimePrerequisite,
  providerAuthenticationFailureReadiness,
  RuntimePrerequisiteError,
  type RuntimeReadiness,
} from "./runtime-readiness.js";
import { resolveOfficialLarkCli } from "../app/official-lark-cli.js";
import { assertAgentWorkspaceBound, managedLarkCliEnv } from "../app/agent-lark-cli-workspace.js";
import type { TelemetryRuntime } from "../platform/telemetry-tracing.js";

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
  reason?: string; retryable?: boolean;
}
interface DeliveryFile { version: 1; records: DeliveryRecord[] }
interface DeliveryStateStore {
  readJson<T>(key: "runtimeDeliveries", fallback: T): T;
  readNdjson?<T>(key: "inbox"): T[];
  writeJson(key: "runtimeDeliveries", value: unknown): void;
  withInboxTransaction<T>(operation: () => T): T;
  resolveInboxDeliverySource?(messageId: string): InboxDeliverySourceResolution;
}

export type RuntimeHostEvent =
  | { type: "agent-status"; agentId: string; status: "active" | "inactive" | "error"; error?: string; readiness?: RuntimeReadiness }
  | { type: "session"; agentId: string; runtime: string; sessionId: string; launchId: string; model?: string; reasoningEffort?: string }
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
  retryAfterSubmit: boolean;
  records: Map<string, DeliveryRecord>; byMessage: Map<string, string>; generation: number;
  poller: NodeJS.Timeout | null; retryTimer: NodeJS.Timeout | null; recreateAttempts: number;
  stabilityTimer: NodeJS.Timeout | null; recreateReason: string | null;
  stopped: boolean; disabledReason: string | null; configurationRecovery: Promise<void> | null;
  stateStore?: DeliveryStateStore;
  readiness: RuntimeReadiness | null;
  turnInProgress: boolean; turnHadFailure: boolean; turnHadAuthenticatedOutput: boolean; authFailureActive: boolean;
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
  resetSession?(agentId: string): Promise<RuntimeSessionResetResult>;
}

export interface RuntimeSessionResetResult {
  generationChanged: boolean;
  sessionChanged: boolean;
  turns: 0;
  runtimeReady: true;
  pendingCount: 0;
  sessionId: string | null;
}

export class RuntimeSessionResetError extends Error {
  constructor(readonly code: "unknown_agent" | "agent_busy" | "inbox_backlog", message: string, readonly pendingCount = 0) {
    super(message);
    this.name = "RuntimeSessionResetError";
  }
}

export interface StagedRuntimeCandidate {
  readonly readiness: RuntimeReadiness;
  commit(): Promise<void>;
  rollback(reason: string): Promise<void>;
}

const MAX_DELIVERIES = 2048;
const now = (): string => new Date().toISOString();
const isActiveDelivery = (status: DeliveryStatus): boolean => ["pending", "submitting", "accepted"].includes(status);
type ReplayFailureCode = "canonical_inbox_row_missing" | "canonical_inbox_malformed" | "duplicate_message_id" | "inbox_state_conflict" | "delivery_target_conflict" | "structured_target_missing";
const REPLAY_FAILURE_CODES: ReadonlySet<string> = new Set<ReplayFailureCode>([
  "canonical_inbox_row_missing", "canonical_inbox_malformed", "duplicate_message_id",
  "inbox_state_conflict", "delivery_target_conflict", "structured_target_missing",
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
  return bounded;
}

export function createRuntimeHost(options: {
  adapterFor(runtime: string): RuntimeAdapter; promptBuilder: ContextPromptBuilder; log?: (...parts: unknown[]) => void;
  stateStoreFor?(agentId: string): DeliveryStateStore;
  assertOfficialCliReady?(config: AgentRuntimeConfig, env: NodeJS.ProcessEnv): void | Promise<void>;
  retryPolicy?: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; stableWindowMs?: number };
  telemetry?: TelemetryRuntime;
}): RuntimeHost {
  const managed = new Map<string, ManagedAgent>();
  const listeners = new Set<(event: RuntimeHostEvent) => void>();
  const log = options.log ?? (() => {});
  const telemetry = options.telemetry;
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
    let target = typeof record.target === "string" && isCanonicalInboxTarget(record.target) ? record.target : null;
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
      target = source.target;
    }
    if (!target) return { status: "error", code: "structured_target_missing", reason: replayFailureReason("structured_target_missing") };
    const staleInput = record.input && typeof record.input === "object" ? record.input : null;
    const attempt = Number.isSafeInteger(staleInput?.attempt) && Number(staleInput?.attempt) >= 0 ? Number(staleInput!.attempt) : 0;
    const inputId = typeof staleInput?.inputId === "string" && staleInput.inputId ? staleInput.inputId : record.deliveryId;
    record.target = target;
    record.input = {
      inputId,
      deliveryId: record.deliveryId,
      kind: busy ? "inbox_update" : "wake",
      text: options.promptBuilder.buildInboxNotice({ busy, count: 1, deliveryId: record.deliveryId, target,
        ...(record.wakeReason ? { wakeReason: record.wakeReason } : {}) }),
      attempt,
    };
    return { status: "ready", target };
  };

  const quarantineRecord = (agent: ManagedAgent, record: DeliveryRecord, code: ReplayFailureCode): DeliveryReceipt => {
    const reason = replayFailureReason(code);
    scrubQuarantinedInput(record, reason);
    record.reason = reason;
    record.retryable = false;
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
      delete record.reason;
      delete record.retryable;
      const finalRecord = setRecord(agent, record, "accepted");
      if (finalRecord.status !== "consumed") emit({ type: "delivery", agentId: agent.config.agentId,
        deliveryId: record.deliveryId, messageId: record.messageId, status: "accepted" });
      return { status: "accepted", deliveryId: record.deliveryId };
    }
    const retryable = result.status === "deferred" || result.retryable;
    record.reason = result.reason;
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
      record.reason = reason;
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
    }
  };

  const retryPending = async (agent: ManagedAgent): Promise<void> => {
    reconcileExternalConsumption(agent);
    if (agent.submitting) { agent.retryAfterSubmit = true; return; }
    if (agent.busy || agent.turnInProgress || !agent.session) return;
    const record = [...agent.records.values()].find((candidate) => candidate.status === "pending" || candidate.status === "submitting");
    if (record) await submit(agent, record, false);
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
      void ensureSession(agent).then(() => {
        return retryPending(agent);
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

  const observe = (agent: ManagedAgent, session: RuntimeSession, event: NormalizedRuntimeEvent): void => {
    if (agent.session !== session) return; // Ignore late output from a replaced child.
    // Keep the trace parent published until authoritative Inbox reconciliation
    // has observed any direct CLI poll completed by this turn.
    if (event.type !== "turn-end") telemetry?.runtimeEvent(agent.config.agentId, event);
    emit({ type: "runtime", agentId: agent.config.agentId, event });
    if (event.type === "session-init") {
      agent.config.sessionId = event.sessionId;
      emit({ type: "session", agentId: agent.config.agentId, runtime: agent.adapter.id, sessionId: event.sessionId, launchId: agent.launchId,
        ...(event.model ? { model: event.model } : {}), ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}) });
      void retryPending(agent);
    } else if (event.type === "turn-start") {
      agent.busy = true;
      agent.turnInProgress = true;
      agent.turnHadFailure = false;
      agent.turnHadAuthenticatedOutput = false;
      markSessionStable(agent, session);
      emit({ type: "activity", agentId: agent.config.agentId, activity: "working", activityKind: "working", detailKind: "turn_started" });
    } else if (event.type === "turn-end") {
      const recoveredAuthentication = agent.authFailureActive && agent.turnInProgress
        && agent.turnHadAuthenticatedOutput && !agent.turnHadFailure;
      agent.turnInProgress = false;
      agent.busy = false;
      emit({ type: "activity", agentId: agent.config.agentId, activity: "idle", activityKind: "idle", detailKind: "turn_ended" });
      reconcileAcceptedAtTurnEnd(agent);
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
      void retryPending(agent);
    } else if (event.type === "activity") {
      if (agent.turnInProgress && event.activity !== "internal") agent.turnHadAuthenticatedOutput = true;
      emit({ type: "activity", agentId: agent.config.agentId, activity: event.activity, activityKind: event.activity });
    } else if (event.type === "input-error") {
      const record = event.inputId
        ? agent.records.get(event.inputId) ?? [...agent.records.values()].find((candidate) => candidate.input.inputId === event.inputId)
        : undefined;
      if (!record || record.status === "consumed" || record.status === "error") return;
      agent.turnHadFailure = true;
      if (event.willRetry) {
        emit({ type: "delivery", agentId: agent.config.agentId, deliveryId: record.deliveryId,
          messageId: record.messageId, status: "deferred", reason: event.message });
        return;
      }
      const submittedWhileBusy = record.input.kind === "inbox_update" || record.input.kind === "inbox-update";
      if (!submittedWhileBusy) agent.busy = false;
      record.reason = event.message;
      record.retryable = event.retryable;
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
          const candidate: ManagedAgent = {
            ...previous, config, adapter, session, launchId: crypto.randomUUID(), busy: false, submitting: false,
            starting: null, retryAfterSubmit: false, generation: 0, poller: null, retryTimer: null,
            recreateAttempts: 0, stabilityTimer: null, recreateReason: null, stopped: false,
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
          records: new Map(persisted.records.map((record) => [record.deliveryId, record])),
          byMessage: new Map(persisted.records.map((record) => [record.messageId, record.deliveryId])),
          generation: 0, poller: null, retryTimer: null, recreateAttempts: 0,
          stabilityTimer: null, recreateReason: null, stopped: false, disabledReason: null,
          configurationRecovery: null, stateStore, readiness: null,
          turnInProgress: false, turnHadFailure: false, turnHadAuthenticatedOutput: false, authFailureActive: false };
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
          activeCount += 1;
          await retryPending(agent);
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
          if (typeof envelope.wake_reason === "string") existing.wakeReason = envelope.wake_reason;
          const priorAttempt = existing.input && Number.isSafeInteger(existing.input.attempt) ? existing.input.attempt : 0;
          existing.input = existing.input && typeof existing.input === "object"
            ? { ...existing.input, attempt: priorAttempt + 1 }
            : { inputId: existing.deliveryId, deliveryId: existing.deliveryId, kind: "wake", text: "", attempt: priorAttempt + 1 };
          delete existing.reason;
          delete existing.retryable;
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
      if (agent.busy) await agent.session?.cancel(reason);
      await agent.session?.close(reason); managed.delete(agentId);
      emit({ type: "agent-status", agentId, status: "inactive" });
    },
    async shutdown(reason): Promise<void> { await Promise.allSettled([...managed.keys()].map((id) => this.stop(id, reason))); },
    subscribe(listener): () => void { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
