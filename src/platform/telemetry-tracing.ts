import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { context, SpanKind, SpanStatusCode, trace, type Context, type Span, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { NormalizedRuntimeEvent } from "../runtime/runtime-contracts.js";
import type { TelemetryConfig } from "./telemetry-config.js";
import { TelemetrySpool, type OtlpPayload } from "./telemetry-spool.js";
import { startTelemetryUploader } from "./telemetry-uploader.js";
import { inspectProcess } from "./process-state.js";

const nanos = ([seconds, nanoseconds]: readonly [number, number]): string => (BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds)).toString();
// OTel JS uses zero-based SpanKind values while OTLP's enum starts at 1.
const kind = (value: SpanKind): number => value + 1;
const attributeValue = (value: unknown): Record<string, unknown> => {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(attributeValue) } };
  return { stringValue: String(value) };
};
const attributes = (values: Record<string, unknown>): unknown[] => Object.entries(values)
  .filter(([, value]) => value !== undefined && value !== null)
  .map(([key, value]) => ({ key, value: attributeValue(value) }));

function serializeSpan(span: ReadableSpan): OtlpPayload {
  const resourceAttributes = span.resource.attributes as Record<string, unknown>;
  const spanContext = span.spanContext();
  return { resourceSpans: [{
    resource: { attributes: attributes(resourceAttributes) },
    scopeSpans: [{ scope: { name: span.instrumentationScope.name, version: span.instrumentationScope.version }, spans: [{
      traceId: spanContext.traceId, spanId: spanContext.spanId,
      ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
      name: span.name, kind: kind(span.kind), startTimeUnixNano: nanos(span.startTime), endTimeUnixNano: nanos(span.endTime),
      attributes: attributes(span.attributes as Record<string, unknown>),
      links: span.links.map((link) => ({ traceId: link.context.traceId, spanId: link.context.spanId,
        traceState: link.context.traceState?.serialize(), flags: link.context.traceFlags,
        attributes: attributes((link.attributes ?? {}) as Record<string, unknown>) })),
      status: { code: span.status.code }, flags: spanContext.traceFlags,
    }] }],
  }] };
}

class DurableSpanExporter implements SpanExporter {
  constructor(private readonly spool: TelemetrySpool, private readonly diagnostic?: (category: string) => void) {}
  export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
    try { for (const span of spans) this.spool.enqueue(serializeSpan(span)); callback({ code: 0 }); }
    catch { this.diagnostic?.("spool"); callback({ code: 1 }); }
  }
  async shutdown(): Promise<void> {}
}

interface MessageTrace {
  root: Span; context: Context; agentId: string; messageHash: string; turn?: Span; turnContext?: Context;
  activitySpan?: Span; activityName?: "model.activity" | "tool.execute";
  pi?: {
    distribution: "builtin" | "external";
    submitAt?: number; acceptedAt?: number; turnStartAt?: number; firstOutputAt?: number; completedAt?: number; settledAt?: number;
    rpcSpan?: Span; lifecycleSpan?: Span; outputWaitSpan?: Span; generationSpan?: Span; toolSpan?: Span; settleSpan?: Span;
  };
}
export interface TelemetryRuntime {
  beginMessage(agentId: string, messageId: string, source?: "im" | "document_comment"): void;
  phase<T>(messageId: string, name: "feishu.receive" | "runtime.deliver" | "document.comment.receive" | "document.comment.gate"
    | "document.comment.pending" | "document.comment.replay" | "document.comment.resolve" | "document.comment.inbox",
    spanKind: SpanKind, operation: () => Promise<T>): Promise<T>;
  filterMessage(messageId: string, reason: "subscription_unverified" | "self_or_missing_operator" | "unsupported_file_type" | "duplicate"): void;
  delivery(agentId: string, messageId: string, status: "accepted" | "consumed" | "deferred" | "duplicate" | "error"): void;
  runtimeEvent(agentId: string, event: NormalizedRuntimeEvent): void;
  externalPhase<T>(agentId: string, stateDir: string, name: "inbox.consume" | "tool.execute" | "feishu.send" | "document.comment.reply", spanKind: SpanKind,
    operation: () => T | Promise<T>, boundary?: "agent_cli" | "agent_transport" | "comment_cli"): T | Promise<T>;
  shutdown(): Promise<void>;
}

const NOOP: TelemetryRuntime = {
  beginMessage() {}, async phase(_id, _name, _kind, operation) { return operation(); }, filterMessage() {}, delivery() {}, runtimeEvent() {},
  externalPhase(_agent, _state, _name, _kind, operation) { return operation(); }, async shutdown() {},
};

const safeHash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const activeContextFile = (stateDir: string): string => path.join(stateDir, "telemetry-active-context.json");
const generationFile = (stateDir: string): string => path.join(stateDir, "telemetry-runtime-generation.json");
function atomicStateWrite(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { try { fs.unlinkSync(temporary); } catch { /* isolated */ } }
}
function readStateJson(file: string): Record<string, unknown> {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(descriptor); if (!stat.isFile()) throw new Error("invalid state"); return JSON.parse(fs.readFileSync(descriptor, "utf8")) as Record<string, unknown>; }
  finally { fs.closeSync(descriptor); }
}
function writeActiveContext(stateDir: string | undefined, value: SpanContext | null, generation: string, now: number): void {
  if (!stateDir) return;
  const file = activeContextFile(stateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!value) { try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return; }
    atomicStateWrite(file, { version: 2, generation, traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags,
      expiresAt: now + 30 * 60 * 1000 });
  } catch { /* telemetry cannot alter business behavior */ }
}
interface OwnerInspection { ok: boolean; startToken?: string }
function readActiveContext(stateDir: string, now: number, inspectOwner: (pid: number) => OwnerInspection): SpanContext | null {
  try {
    const file = activeContextFile(stateDir); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = readStateJson(file);
    const generationStat = fs.lstatSync(generationFile(stateDir));
    if (!generationStat.isFile() || generationStat.isSymbolicLink()) return null;
    const owner = readStateJson(generationFile(stateDir)); const ownerPid = Number(owner.pid);
    if (value.version !== 2 || owner.version !== 1 || value.generation !== owner.generation
      || Number(value.expiresAt) <= now || Number(owner.expiresAt) <= now
      || !Number.isSafeInteger(ownerPid) || ownerPid <= 0
      || !/^[0-9a-f]{32}$/.test(String(value.traceId)) || !/^[0-9a-f]{16}$/.test(String(value.spanId))) return null;
    const inspected = inspectOwner(ownerPid);
    if (!inspected.ok || !inspected.startToken || inspected.startToken !== owner.processStartToken) return null;
    return { traceId: String(value.traceId), spanId: String(value.spanId), traceFlags: Number(value.traceFlags) || 1, isRemote: true };
  } catch { return null; }
}

interface TelemetryRuntimeOptions {
  stateDirFor?(agentId: string): string | undefined; stateDirs?: readonly string[]; serviceVersion?: string;
  now?(): number; processStartToken?: string; inspectOwner?(pid: number): OwnerInspection; maintenanceIntervalMs?: number;
}
export function createTelemetryRuntime(config: TelemetryConfig, options: TelemetryRuntimeOptions = {}): TelemetryRuntime {
  const spool = new TelemetrySpool(config);
  const exporter = new DurableSpanExporter(spool);
  const runtimeGeneration = crypto.randomUUID();
  const startupId = crypto.randomUUID();
  const now = options.now ?? Date.now;
  const inspectOwner = options.inspectOwner ?? ((pid: number) => inspectProcess(pid));
  const processStartToken = options.processStartToken ?? inspectOwner(process.pid).startToken;
  const initializedStateDirs = new Set<string>();
  const initializeStateDir = (stateDir: string): void => {
    if (initializedStateDirs.has(stateDir)) return;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(activeContextFile(stateDir)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      atomicStateWrite(generationFile(stateDir), { version: 1, generation: runtimeGeneration, pid: process.pid,
        processStartToken, expiresAt: now() + 24 * 60 * 60 * 1000 });
      initializedStateDirs.add(stateDir);
    } catch { /* isolated */ }
  };
  const renewStateDir = (stateDir: string): void => {
    try {
      const owner = readStateJson(generationFile(stateDir));
      if (owner.generation === runtimeGeneration && Number(owner.expiresAt) - now() < 12 * 60 * 60 * 1000) {
        atomicStateWrite(generationFile(stateDir), { version: 1, generation: runtimeGeneration, pid: process.pid,
          processStartToken, expiresAt: now() + 24 * 60 * 60 * 1000 });
      }
    } catch { /* isolated */ }
  };
  const writeContext = (agentId: string, value: SpanContext | null): void => {
    const stateDir = options.stateDirFor?.(agentId); if (!stateDir) return;
    initializeStateDir(stateDir); renewStateDir(stateDir);
    writeActiveContext(stateDir, value, runtimeGeneration, now());
  };
  for (const stateDir of options.stateDirs ?? []) {
    initializeStateDir(stateDir);
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "larkin", "service.version": options.serviceVersion ?? "dev",
      "service.instance.id": startupId }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    spanLimits: { attributeCountLimit: 16, attributeValueLengthLimit: 96, eventCountLimit: 0, linkCountLimit: 8 },
  });
  provider.register();
  const tracer = provider.getTracer("larkin.telemetry", "1.0.0");
  const messages = new Map<string, MessageTrace>();
  const activeByAgent = new Map<string, MessageTrace>();
  // Runtime observations can precede the acceptance receipt. Correlate them
  // without publishing or changing the authoritative active delivery state.
  const observingByAgent = new Map<string, MessageTrace>();
  const ownershipTimer = setInterval(() => {
    for (const stateDir of initializedStateDirs) renewStateDir(stateDir);
    for (const [agentId, current] of activeByAgent) writeContext(agentId, current.turn?.spanContext() ?? current.root.spanContext());
  }, options.maintenanceIntervalMs ?? 10 * 60 * 1000);
  ownershipTimer.unref?.();
  const uploader = startTelemetryUploader(spool, config);
  const closeActivity = (current: MessageTrace): void => {
    current.activitySpan?.end(); delete current.activitySpan; delete current.activityName;
  };
  const closePi = (current: MessageTrace, failed = false): void => {
    const state = current.pi; if (!state) return;
    for (const key of ["rpcSpan", "lifecycleSpan", "outputWaitSpan", "generationSpan", "toolSpan", "settleSpan"] as const) {
      const span = state[key];
      if (!span) continue;
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(); delete state[key];
    }
  };
  const endTrace = (current: MessageTrace, failed = false): void => {
    closeActivity(current);
    closePi(current, failed);
    if (current.turn) { if (failed) current.turn.setStatus({ code: SpanStatusCode.ERROR }); current.turn.end(); }
    if (failed) current.root.setStatus({ code: SpanStatusCode.ERROR }); current.root.end();
    for (const [messageId, candidate] of messages) if (candidate === current) messages.delete(messageId);
    if (activeByAgent.get(current.agentId) === current) {
      activeByAgent.delete(current.agentId);
      writeContext(current.agentId, null);
    }
    if (observingByAgent.get(current.agentId) === current) observingByAgent.delete(current.agentId);
  };
  return {
    beginMessage(agentId, messageId, source = "im") {
      try {
        if (messages.has(messageId)) return;
        const active = activeByAgent.get(agentId);
        const linkedContext = active?.turn?.spanContext() ?? active?.root.spanContext();
        const root = tracer.startSpan("larkin.message.process", { kind: SpanKind.CONSUMER,
          attributes: { "larkin.agent.id_hash": safeHash(agentId), "messaging.message.id_hash": safeHash(messageId),
            "larkin.message.source": source,
            ...(linkedContext ? { "larkin.message.relation": "fan_in" } : {}) },
          ...(linkedContext ? { links: [{ context: linkedContext }] } : {}),
        });
        const value = { root, context: trace.setSpan(context.active(), root), agentId, messageHash: safeHash(messageId) };
        messages.set(messageId, value);
      } catch { /* isolated */ }
    },
    async phase(messageId, name, spanKind, operation) {
      const current = messages.get(messageId);
      if (!current) return operation();
      if (name === "runtime.deliver" && !activeByAgent.has(current.agentId)) observingByAgent.set(current.agentId, current);
      let span: Span;
      try { span = tracer.startSpan(name, { kind: spanKind }, current.context); }
      catch {
        if (observingByAgent.get(current.agentId) === current) observingByAgent.delete(current.agentId);
        return operation();
      }
      try { return await context.with(trace.setSpan(current.context, span), operation); }
      catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (!name.startsWith("document.comment.")) endTrace(current, true);
        throw error;
      }
      finally {
        span.end();
        if (observingByAgent.get(current.agentId) === current) observingByAgent.delete(current.agentId);
      }
    },
    filterMessage(messageId, reason) {
      try {
        const current = messages.get(messageId); if (!current) return;
        current.root.setAttribute("larkin.filter.reason", reason);
        endTrace(current, false);
      } catch { /* isolated */ }
    },
    delivery(agentId, messageId, status) {
      try {
        const current = messages.get(messageId) ?? activeByAgent.get(agentId); if (!current) return;
        if (status === "accepted") {
          const active = activeByAgent.get(agentId);
          if (active && active !== current) { endTrace(current, false); return; }
          activeByAgent.set(agentId, current);
          writeContext(agentId, current.turn?.spanContext() ?? current.root.spanContext());
        }
        if (status === "error") endTrace(current, true);
        if (status === "deferred") endTrace(current, true);
        if (status === "duplicate") endTrace(current, false);
      } catch { /* isolated */ }
    },
    runtimeEvent(agentId, event) {
      try {
        const current = activeByAgent.get(agentId) ?? observingByAgent.get(agentId); if (!current) return;
        if (event.type === "runtime-observation" && event.runtime === "pi") {
          const state = current.pi ??= { distribution: event.distribution };
          state.distribution = event.distribution;
          const observedAt = now();
          if (event.distribution !== "builtin" || state.settledAt !== undefined) return;
          const spanAttributes = { "larkin.observation.boundary": "pi_rpc", "larkin.runtime.id": "pi",
            "larkin.runtime.distribution": "builtin" };
          const start = (name: "pi.rpc.submit" | "pi.rpc.lifecycle" | "pi.output.wait" | "pi.generation"
            | "pi.tool.wait" | "pi.rpc.settle", startTime: number): Span | undefined => {
            if (!current.turnContext) return undefined;
            return tracer.startSpan(name, { kind: SpanKind.INTERNAL, startTime, attributes: spanAttributes }, current.turnContext);
          };
          if (event.phase === "rpc_submit" && state.submitAt === undefined && state.acceptedAt === undefined) state.submitAt = observedAt;
          else if (event.phase === "rpc_accepted" && state.submitAt !== undefined && state.acceptedAt === undefined) {
            state.acceptedAt = observedAt;
            if (state.rpcSpan) { state.rpcSpan.end(observedAt); delete state.rpcSpan; }
            if (current.turnContext && !state.outputWaitSpan) state.outputWaitSpan = start("pi.output.wait", observedAt);
          } else if (event.phase === "turn_start" && state.turnStartAt === undefined) state.turnStartAt = observedAt;
          else if (event.phase === "first_output" && state.firstOutputAt === undefined && state.completedAt === undefined) {
            state.firstOutputAt = observedAt;
            if (state.outputWaitSpan) { state.outputWaitSpan.end(observedAt); delete state.outputWaitSpan; }
            if (current.turnContext && !state.generationSpan) state.generationSpan = start("pi.generation", observedAt);
          } else if (event.phase === "tool_call" && state.completedAt === undefined && !state.toolSpan) {
            state.toolSpan = start("pi.tool.wait", observedAt);
          } else if (event.phase === "tool_result" && state.toolSpan) {
            state.toolSpan.end(observedAt); delete state.toolSpan;
          } else if (event.phase === "completed" && state.completedAt === undefined) {
            state.completedAt = observedAt;
            if (state.generationSpan) { state.generationSpan.end(observedAt); delete state.generationSpan; }
            if (!state.settleSpan) state.settleSpan = start("pi.rpc.settle", observedAt);
          } else if (event.phase === "settled") {
            state.settledAt = observedAt;
            if (state.toolSpan) { state.toolSpan.end(observedAt); delete state.toolSpan; }
            if (state.generationSpan) { state.generationSpan.end(observedAt); delete state.generationSpan; }
            if (state.settleSpan) { state.settleSpan.end(observedAt); delete state.settleSpan; }
            if (state.lifecycleSpan) { state.lifecycleSpan.end(observedAt); delete state.lifecycleSpan; }
          }
        } else if (event.type === "turn-start") {
          if (current.turn) return;
          const pi = current.pi;
          current.turn = tracer.startSpan("agent.turn", { kind: SpanKind.INTERNAL,
            ...(pi?.submitAt !== undefined ? { startTime: pi.submitAt } : {}),
            attributes: { "larkin.observation.boundary": "runtime_host",
              ...(pi ? { "larkin.runtime.id": "pi", "larkin.runtime.distribution": pi.distribution } : {}) } }, current.context);
          current.turnContext = trace.setSpan(current.context, current.turn);
          if (pi?.distribution === "builtin") {
            const spanAttributes = { "larkin.observation.boundary": "pi_rpc", "larkin.runtime.id": "pi",
              "larkin.runtime.distribution": "builtin" };
            const submitAt = pi.submitAt ?? pi.turnStartAt ?? now();
            pi.lifecycleSpan = tracer.startSpan("pi.rpc.lifecycle", { kind: SpanKind.INTERNAL, startTime: submitAt,
              attributes: spanAttributes }, current.turnContext);
            if (pi.submitAt !== undefined) {
              pi.rpcSpan = tracer.startSpan("pi.rpc.submit", { kind: SpanKind.INTERNAL, startTime: pi.submitAt,
                attributes: spanAttributes }, current.turnContext);
              if (pi.acceptedAt !== undefined && pi.acceptedAt >= pi.submitAt) { pi.rpcSpan.end(pi.acceptedAt); delete pi.rpcSpan; }
            }
            const waitAt = pi.acceptedAt ?? pi.turnStartAt ?? now();
            pi.outputWaitSpan = tracer.startSpan("pi.output.wait", { kind: SpanKind.INTERNAL, startTime: waitAt,
              attributes: spanAttributes }, current.turnContext);
            if (pi.firstOutputAt !== undefined) { pi.outputWaitSpan.end(pi.firstOutputAt); delete pi.outputWaitSpan; }
          }
          writeContext(agentId, current.turn.spanContext());
        } else if (event.type === "activity") {
          const activityName = event.activity === "tool" ? "tool.execute" : "model.activity";
          writeContext(agentId, current.turn?.spanContext() ?? current.root.spanContext());
          if (current.activityName === activityName) return;
          closeActivity(current);
          const activitySpan = tracer.startSpan(activityName, { kind: SpanKind.INTERNAL,
            attributes: { "larkin.activity.type": event.activity, "larkin.observation.boundary": "runtime_event_interval" } }, current.turnContext ?? current.context);
          current.activityName = activityName; current.activitySpan = activitySpan;
        } else if (event.type === "input-error") {
          current.turn?.setStatus({ code: SpanStatusCode.ERROR });
        } else if (event.type === "turn-end") endTrace(current, false);
        else if (event.type === "error" || event.type === "configuration-error" || event.type === "closed") endTrace(current, true);
      } catch { /* isolated */ }
    },
    externalPhase<T>(agentId: string, stateDir: string, name: "inbox.consume" | "tool.execute" | "feishu.send" | "document.comment.reply", spanKind: SpanKind,
      operation: () => T | Promise<T>, boundary: "agent_cli" | "agent_transport" | "comment_cli" = "agent_transport") {
      let span: Span; let parentContext: Context;
      try {
        const parent = readActiveContext(stateDir, now(), inspectOwner);
        parentContext = parent ? trace.setSpanContext(context.active(), parent) : context.active();
        span = tracer.startSpan(name, { kind: spanKind, attributes: { "larkin.agent.id_hash": safeHash(agentId),
          "larkin.observation.boundary": boundary } }, parentContext);
      } catch { return operation(); }
      let result: T | Promise<T>;
      try { result = context.with(trace.setSpan(parentContext, span), operation); }
      catch (error) {
        if (name === "document.comment.reply") span.setAttribute("larkin.operation.outcome", "error");
        span.setStatus({ code: SpanStatusCode.ERROR }); span.end(); throw error;
      }
      const recordOutcome = (value: T): T => {
        if (name === "document.comment.reply") {
          const success = typeof value !== "number" || value === 0;
          span.setAttribute("larkin.operation.outcome", success ? "success" : "error");
          if (!success) span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return value;
      };
      if (result && typeof (result as Promise<T>).then === "function") {
        return Promise.resolve(result).then(recordOutcome).catch((error) => {
          if (name === "document.comment.reply") span.setAttribute("larkin.operation.outcome", "error");
          span.setStatus({ code: SpanStatusCode.ERROR }); throw error;
        })
          .finally(() => span.end());
      }
      recordOutcome(result as T); span.end(); return result;
    },
    async shutdown() {
      uploader?.stop();
      clearInterval(ownershipTimer);
      for (const current of new Set(messages.values())) endTrace(current, true);
      for (const stateDir of initializedStateDirs) {
        try {
          const owner = JSON.parse(fs.readFileSync(generationFile(stateDir), "utf8")) as Record<string, unknown>;
          if (owner.generation !== runtimeGeneration) continue;
          for (const file of [activeContextFile(stateDir), generationFile(stateDir)]) {
            try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        } catch { /* isolated */ }
      }
      await provider.forceFlush().catch(() => {}); await provider.shutdown().catch(() => {});
    },
  };
}

let singleton: TelemetryRuntime | null = null;
export function telemetrySingleton(config?: TelemetryConfig, options?: {
  stateDirFor?(agentId: string): string | undefined; stateDirs?: readonly string[]; serviceVersion?: string;
  now?(): number; processStartToken?: string; inspectOwner?(pid: number): OwnerInspection; maintenanceIntervalMs?: number;
}): TelemetryRuntime {
  if (!singleton && config) singleton = createTelemetryRuntime(config, options);
  return singleton ?? NOOP;
}
