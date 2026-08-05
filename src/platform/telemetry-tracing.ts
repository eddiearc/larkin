import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { context, SpanKind, SpanStatusCode, trace, type Context, type Span, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { packageVersion } from "./build-info.js";
import type { NormalizedRuntimeEvent } from "../runtime/runtime-contracts.js";
import type { TelemetryConfig } from "./telemetry-config.js";
import { TelemetrySpool, type OtlpPayload } from "./telemetry-spool.js";
import { startTelemetryUploader } from "./telemetry-uploader.js";

const nanos = ([seconds, nanoseconds]: readonly [number, number]): string => (BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds)).toString();
const kind = (value: SpanKind): number => value;
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

interface MessageTrace { root: Span; context: Context; agentId: string; messageHash: string; turn?: Span; turnContext?: Context }
export interface TelemetryRuntime {
  readonly enabled: boolean;
  beginMessage(agentId: string, messageId: string): void;
  phase<T>(messageId: string, name: "feishu.receive" | "runtime.deliver", spanKind: SpanKind, operation: () => Promise<T>): Promise<T>;
  delivery(agentId: string, messageId: string, status: "accepted" | "consumed" | "deferred" | "duplicate" | "error"): void;
  runtimeEvent(agentId: string, event: NormalizedRuntimeEvent): void;
  externalPhase<T>(agentId: string, stateDir: string, name: "inbox.consume" | "tool.execute" | "feishu.send", spanKind: SpanKind, operation: () => T | Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}

const NOOP: TelemetryRuntime = {
  enabled: false, beginMessage() {}, async phase(_id, _name, _kind, operation) { return operation(); }, delivery() {}, runtimeEvent() {},
  async externalPhase(_agent, _state, _name, _kind, operation) { return operation(); }, async shutdown() {},
};

const safeHash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const activeContextFile = (stateDir: string): string => path.join(stateDir, "telemetry-active-context.json");
function writeActiveContext(stateDir: string | undefined, value: SpanContext | null): void {
  if (!stateDir) return;
  const file = activeContextFile(stateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!value) { try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } return; }
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000 }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  } catch { /* telemetry cannot alter business behavior */ }
}
function readActiveContext(stateDir: string): SpanContext | null {
  try {
    const file = activeContextFile(stateDir); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (value.version !== 1 || Number(value.expiresAt) < Date.now()
      || !/^[0-9a-f]{32}$/.test(String(value.traceId)) || !/^[0-9a-f]{16}$/.test(String(value.spanId))) return null;
    return { traceId: String(value.traceId), spanId: String(value.spanId), traceFlags: Number(value.traceFlags) || 1, isRemote: true };
  } catch { return null; }
}

export function createTelemetryRuntime(config: TelemetryConfig, options: { stateDirFor?(agentId: string): string | undefined } = {}): TelemetryRuntime {
  if (!config.enabled) return NOOP;
  const spool = new TelemetrySpool(config);
  const exporter = new DurableSpanExporter(spool);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "larkin", "service.version": packageVersion(process.cwd()),
      "service.instance.id": crypto.randomUUID() }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    spanLimits: { attributeCountLimit: 16, attributeValueLengthLimit: 96, eventCountLimit: 0, linkCountLimit: 8 },
  });
  provider.register();
  const tracer = provider.getTracer("larkin.telemetry", "1.0.0");
  const messages = new Map<string, MessageTrace>();
  const activeByAgent = new Map<string, MessageTrace>();
  const uploader = startTelemetryUploader(spool, config);
  const endTrace = (current: MessageTrace, failed = false): void => {
    if (current.turn) { if (failed) current.turn.setStatus({ code: SpanStatusCode.ERROR }); current.turn.end(); }
    if (failed) current.root.setStatus({ code: SpanStatusCode.ERROR }); current.root.end();
    for (const [messageId, candidate] of messages) if (candidate === current) messages.delete(messageId);
    if (activeByAgent.get(current.agentId) === current) {
      activeByAgent.delete(current.agentId);
      writeActiveContext(options.stateDirFor?.(current.agentId), null);
    }
  };
  return {
    enabled: true,
    beginMessage(agentId, messageId) {
      try {
        const active = activeByAgent.get(agentId);
        const linkedContext = active?.turn?.spanContext() ?? active?.root.spanContext();
        const root = tracer.startSpan("larkin.message.process", { kind: SpanKind.CONSUMER,
          attributes: { "larkin.agent.id_hash": safeHash(agentId), "messaging.message.id_hash": safeHash(messageId),
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
      let span: Span;
      try { span = tracer.startSpan(name, { kind: spanKind }, current.context); }
      catch { return operation(); }
      try { return await context.with(trace.setSpan(current.context, span), operation); }
      catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); endTrace(current, true); throw error; }
      finally { span.end(); }
    },
    delivery(agentId, messageId, status) {
      try {
        const current = messages.get(messageId) ?? activeByAgent.get(agentId); if (!current) return;
        if (status === "accepted") {
          const active = activeByAgent.get(agentId);
          if (active && active !== current) { endTrace(current, false); return; }
          activeByAgent.set(agentId, current);
          writeActiveContext(options.stateDirFor?.(agentId), current.turn?.spanContext() ?? current.root.spanContext());
        }
        if (status === "consumed") {
          const span = tracer.startSpan("inbox.consume", { kind: SpanKind.CONSUMER }, current.turnContext ?? current.context); span.end();
        }
        if (status === "error") endTrace(current, true);
        if (status === "deferred") endTrace(current, true);
        if (status === "duplicate") endTrace(current, false);
      } catch { /* isolated */ }
    },
    runtimeEvent(agentId, event) {
      try {
        const current = activeByAgent.get(agentId); if (!current) return;
        if (event.type === "turn-start") {
          current.turn = tracer.startSpan("agent.turn", { kind: SpanKind.INTERNAL,
            attributes: { "larkin.observation.boundary": "runtime_host" } }, current.context);
          current.turnContext = trace.setSpan(current.context, current.turn);
          writeActiveContext(options.stateDirFor?.(agentId), current.turn.spanContext());
        } else if (event.type === "activity") {
          const span = tracer.startSpan(event.activity === "tool" ? "tool.execute" : "model.activity", { kind: SpanKind.INTERNAL,
            attributes: { "larkin.activity.type": event.activity, "larkin.observation.boundary": "runtime_event" } }, current.turnContext ?? current.context);
          span.end();
        } else if (event.type === "input-error") {
          current.turn?.setStatus({ code: SpanStatusCode.ERROR });
        } else if (event.type === "turn-end") endTrace(current, false);
        else if (event.type === "error" || event.type === "configuration-error" || event.type === "closed") endTrace(current, true);
      } catch { /* isolated */ }
    },
    async externalPhase(agentId, stateDir, name, spanKind, operation) {
      let span: Span; let parentContext: Context;
      try {
        const parent = readActiveContext(stateDir);
        parentContext = parent ? trace.setSpanContext(context.active(), parent) : context.active();
        span = tracer.startSpan(name, { kind: spanKind, attributes: { "larkin.agent.id_hash": safeHash(agentId) } }, parentContext);
      } catch { return operation(); }
      try { return await context.with(trace.setSpan(parentContext, span), operation); }
      catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
      finally { span.end(); }
    },
    async shutdown() { uploader?.stop(); await provider.forceFlush().catch(() => {}); await provider.shutdown().catch(() => {}); },
  };
}

let singleton: TelemetryRuntime | null = null;
export function telemetrySingleton(config?: TelemetryConfig, options?: { stateDirFor?(agentId: string): string | undefined }): TelemetryRuntime {
  if (!singleton && config) singleton = createTelemetryRuntime(config, options);
  return singleton ?? NOOP;
}
