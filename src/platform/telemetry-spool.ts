import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { TelemetryConfig } from "./telemetry-config.js";

export interface OtlpPayload { resourceSpans: unknown[] }
export interface QueueRecord { file: string; payload: OtlpPayload; device: number; inode: number }
export interface QueueStatus {
  queuedFiles: number; queuedBytes: number; oldestAgeMs: number | null;
  droppedFiles: number; lastUploadAt: string | null; lastErrorCategory: string | null;
}
interface Diagnostics { droppedFiles: number; lastUploadAt: string | null; lastErrorCategory: string | null }
interface BundleRecord { sha256: string; payload: OtlpPayload }
interface TelemetryBundle { format: "larkin-otlp-bundle"; version: 1; createdAt: string; records: BundleRecord[] }
interface ReadyFile { file: string; size: number; mtimeMs: number; device: number; inode: number }

const READY = /^(?:span-[0-9a-f-]+|import-[0-9a-f]{64})\.json$/;
const HEX_TRACE = /^[0-9a-f]{32}$/;
const HEX_SPAN = /^[0-9a-f]{16}$/;
const SPAN_NAMES = new Set(["larkin.message.process", "feishu.receive", "runtime.deliver", "agent.turn", "model.activity", "tool.execute", "inbox.consume", "feishu.send"]);
const ATTRIBUTE_KEYS = new Set(["service.name", "service.version", "service.instance.id", "larkin.agent.id_hash", "messaging.message.id_hash", "larkin.message.relation", "larkin.observation.boundary", "larkin.activity.type"]);
const SENSITIVE = /(?:bearer\s|token\s*[=:]|secret\s*[=:]|cookie\s*[=:]|sk-[a-z0-9_-]{8})/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
const emptyDiagnostics = (): Diagnostics => ({ droppedFiles: 0, lastUploadAt: null, lastErrorCategory: null });
const invalidPayload = (): never => { throw new Error("invalid telemetry payload"); };

function validateValue(value: unknown, depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) invalidPayload();
  const object = value as Record<string, unknown>; const keys = Object.keys(object);
  if (keys.length !== 1 || !["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue"].includes(keys[0]!)) invalidPayload();
  if ("stringValue" in object) {
    const text = object.stringValue;
    if (typeof text !== "string" || text.length > 128 || ABSOLUTE_PATH.test(text) || SENSITIVE.test(text)) invalidPayload();
  } else if ("boolValue" in object && typeof object.boolValue !== "boolean") invalidPayload();
  else if ("intValue" in object && !/^-?[0-9]{1,20}$/.test(String(object.intValue))) invalidPayload();
  else if ("doubleValue" in object && (typeof object.doubleValue !== "number" || !Number.isFinite(object.doubleValue))) invalidPayload();
  else if ("arrayValue" in object) {
    const arrayValue = object.arrayValue as Record<string, unknown>;
    if (!arrayValue || Object.keys(arrayValue).some((key) => key !== "values") || !Array.isArray(arrayValue.values) || arrayValue.values.length > 32) invalidPayload();
    for (const item of arrayValue.values as unknown[]) validateValue(item, depth + 1);
  }
}

function validateAttributes(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) invalidPayload();
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidPayload();
    const attribute = item as Record<string, unknown>;
    if (Object.keys(attribute).some((key) => key !== "key" && key !== "value") || !ATTRIBUTE_KEYS.has(String(attribute.key))) invalidPayload();
    validateValue(attribute.value);
  }
}

export function validateOtlpPayload(payload: unknown): asserts payload is OtlpPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload as object).some((key) => key !== "resourceSpans")) invalidPayload();
  const resourceSpans = (payload as OtlpPayload).resourceSpans;
  if (!Array.isArray(resourceSpans) || resourceSpans.length < 1 || resourceSpans.length > 1024) invalidPayload();
  for (const resourceSpanValue of resourceSpans) {
    const resourceSpan = resourceSpanValue as Record<string, unknown>;
    if (!resourceSpan || typeof resourceSpan !== "object" || Object.keys(resourceSpan).some((key) => key !== "resource" && key !== "scopeSpans")) invalidPayload();
    const resource = resourceSpan.resource as Record<string, unknown>;
    if (!resource || Object.keys(resource).some((key) => key !== "attributes")) invalidPayload();
    validateAttributes(resource.attributes);
    if (!Array.isArray(resourceSpan.scopeSpans) || resourceSpan.scopeSpans.length > 16) invalidPayload();
    for (const scopeSpanValue of resourceSpan.scopeSpans as unknown[]) {
      const scopeSpan = scopeSpanValue as Record<string, unknown>;
      if (!scopeSpan || Object.keys(scopeSpan).some((key) => key !== "scope" && key !== "spans")) invalidPayload();
      const scope = scopeSpan.scope as Record<string, unknown>;
      if (!scope || Object.keys(scope).some((key) => key !== "name" && key !== "version") || typeof scope.name !== "string" || typeof scope.version !== "string") invalidPayload();
      if (!Array.isArray(scopeSpan.spans) || scopeSpan.spans.length > 4096) invalidPayload();
      for (const spanValue of scopeSpan.spans as unknown[]) {
        const span = spanValue as Record<string, unknown>;
        const allowed = new Set(["traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "attributes", "links", "status", "flags"]);
        if (!span || Object.keys(span).some((key) => !allowed.has(key)) || !HEX_TRACE.test(String(span.traceId)) || !HEX_SPAN.test(String(span.spanId))
          || (span.parentSpanId !== undefined && !HEX_SPAN.test(String(span.parentSpanId))) || !SPAN_NAMES.has(String(span.name))
          || !Number.isInteger(span.kind) || Number(span.kind) < 1 || Number(span.kind) > 5
          || !/^[0-9]{1,24}$/.test(String(span.startTimeUnixNano)) || !/^[0-9]{1,24}$/.test(String(span.endTimeUnixNano))
          || BigInt(String(span.endTimeUnixNano)) < BigInt(String(span.startTimeUnixNano))) invalidPayload();
        validateAttributes(span.attributes);
        if (!Array.isArray(span.links) || span.links.length > 8) invalidPayload();
        for (const linkValue of span.links as unknown[]) {
          const link = linkValue as Record<string, unknown>;
          if (!link || Object.keys(link).some((key) => !["traceId", "spanId", "traceState", "flags", "attributes"].includes(key))
            || !HEX_TRACE.test(String(link.traceId)) || !HEX_SPAN.test(String(link.spanId))) invalidPayload();
          validateAttributes(link.attributes);
        }
        const status = span.status as Record<string, unknown>;
        if (!status || Object.keys(status).some((key) => key !== "code") || !Number.isInteger(status.code) || Number(status.code) < 0 || Number(status.code) > 2) invalidPayload();
      }
    }
  }
}

export class TelemetrySpool {
  constructor(readonly config: Pick<TelemetryConfig, "spoolDir" | "maxBytes" | "maxFiles" | "maxAgeMs">) {}

  private ensure(): void {
    const parent = path.dirname(this.config.spoolDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { if (fs.lstatSync(this.config.spoolDir).isSymbolicLink()) throw new Error("invalid telemetry spool"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fs.mkdirSync(this.config.spoolDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.config.spoolDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid telemetry spool");
    fs.chmodSync(this.config.spoolDir, 0o700);
  }

  acquireLease(): (() => void) | null {
    this.ensure(); const lease = path.join(this.config.spoolDir, ".queue.lock"); const token = crypto.randomUUID();
    const create = (): void => {
      fs.mkdirSync(lease, { mode: 0o700 });
      fs.writeFileSync(path.join(lease, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600, flag: "wx" });
    };
    try { create(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lease); if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        let owner: { pid?: unknown; createdAt?: unknown } | null = null;
        try { owner = JSON.parse(fs.readFileSync(path.join(lease, "owner.json"), "utf8")) as { pid?: unknown; createdAt?: unknown }; } catch { /* reclaim only after timeout */ }
        let alive = false;
        if (owner && Number.isSafeInteger(Number(owner.pid)) && Number(owner.pid) > 0) try { process.kill(Number(owner.pid), 0); alive = true; } catch { /* dead */ }
        const age = Date.now() - (owner && Number.isFinite(Number(owner.createdAt)) ? Number(owner.createdAt) : stat.mtimeMs);
        if (alive || age < 2 * 60_000) return null;
        const stale = path.join(this.config.spoolDir, `.stale-lock-${crypto.randomUUID()}`);
        fs.renameSync(lease, stale); const moved = fs.lstatSync(stale);
        if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== stat.dev || moved.ino !== stat.ino) return null;
        fs.rmSync(stale, { recursive: true }); create();
      } catch { return null; }
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      try {
        const ownerFile = path.join(lease, "owner.json"); const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { token?: unknown };
        if (owner.token !== token) return; fs.unlinkSync(ownerFile); fs.rmdirSync(lease);
      } catch { /* isolated */ }
    };
  }

  private readyFiles(): ReadyFile[] {
    this.ensure();
    return fs.readdirSync(this.config.spoolDir).filter((name) => READY.test(name)).flatMap((name) => {
      const file = path.join(this.config.spoolDir, name);
      try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && !stat.isSymbolicLink() ? [{ file, size: stat.size, mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino }] : [];
      } catch { return []; }
    }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  }

  private atomicWrite(file: string, bytes: Buffer): void {
    this.ensure(); const temporary = path.join(this.config.spoolDir, `.write-${process.pid}-${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* isolated */ }
      try { fs.unlinkSync(temporary); } catch { /* isolated */ }
    }
  }

  private removeVerified(entry: Pick<ReadyFile, "file" | "device" | "inode">): boolean {
    const quarantine = path.join(this.config.spoolDir, `.delete-${crypto.randomUUID()}.tmp`);
    try {
      fs.renameSync(entry.file, quarantine);
      const stat = fs.lstatSync(quarantine);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== entry.device || stat.ino !== entry.inode) {
        try { fs.renameSync(quarantine, entry.file); } catch { /* preserve replacement */ }
        return false;
      }
      fs.unlinkSync(quarantine); return true;
    } catch { try { fs.renameSync(quarantine, entry.file); } catch { /* isolated */ } return false; }
  }

  enqueue(payload: OtlpPayload): string {
    validateOtlpPayload(payload);
    const file = path.join(this.config.spoolDir, `span-${crypto.randomUUID()}.json`);
    this.atomicWrite(file, Buffer.from(JSON.stringify(payload)));
    try { this.prune(); } catch { /* telemetry cannot alter business behavior */ }
    return file;
  }

  list(limit = Number.MAX_SAFE_INTEGER): QueueRecord[] {
    const output: QueueRecord[] = [];
    for (const entry of this.readyFiles().slice(0, limit)) {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.dev !== entry.device || stat.ino !== entry.inode) throw new Error("telemetry spool changed");
        const payload: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8")); validateOtlpPayload(payload);
        output.push({ file: entry.file, payload, device: stat.dev, inode: stat.ino });
      } catch { throw new Error("invalid telemetry spool record"); }
      finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* isolated */ } }
    }
    return output;
  }

  acknowledge(records: readonly QueueRecord[]): void {
    const root = `${path.resolve(this.config.spoolDir)}${path.sep}`;
    const moved: Array<{ original: string; quarantine: string }> = [];
    try {
      for (const record of records) {
        const resolved = path.resolve(record.file); const quarantine = path.join(this.config.spoolDir, `.ack-${crypto.randomUUID()}.tmp`);
        if (!resolved.startsWith(root) || !READY.test(path.basename(resolved))) throw new Error("invalid record");
        fs.renameSync(resolved, quarantine); moved.push({ original: resolved, quarantine });
        const stat = fs.lstatSync(quarantine);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== record.device || stat.ino !== record.inode) throw new Error("record changed");
      }
      for (const entry of moved) fs.unlinkSync(entry.quarantine);
    } catch {
      for (const entry of moved.reverse()) try { fs.renameSync(entry.quarantine, entry.original); } catch { /* preserve without deleting */ }
      throw new Error("telemetry acknowledgement failed");
    }
  }

  private diagnostics(): Diagnostics {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.config.spoolDir, "diagnostics.json"), "utf8")) as Partial<Diagnostics>;
      return { droppedFiles: Number.isSafeInteger(parsed.droppedFiles) && Number(parsed.droppedFiles) >= 0 ? Number(parsed.droppedFiles) : 0,
        lastUploadAt: typeof parsed.lastUploadAt === "string" ? parsed.lastUploadAt : null,
        lastErrorCategory: typeof parsed.lastErrorCategory === "string" ? parsed.lastErrorCategory : null };
    } catch { return emptyDiagnostics(); }
  }

  updateDiagnostics(patch: Partial<Diagnostics>): void {
    this.atomicWrite(path.join(this.config.spoolDir, "diagnostics.json"), Buffer.from(JSON.stringify({ ...this.diagnostics(), ...patch })));
  }

  prune(now = Date.now()): void {
    const release = this.acquireLease(); if (!release) return;
    try {
      let files = this.readyFiles(); let dropped = 0;
      for (const entry of files.filter((item) => now - item.mtimeMs > this.config.maxAgeMs)) if (this.removeVerified(entry)) dropped += 1;
      files = this.readyFiles(); let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
      while (files.length > this.config.maxFiles || bytes > this.config.maxBytes) {
        const oldest = files.shift(); if (!oldest) break;
        if (this.removeVerified(oldest)) { bytes -= oldest.size; dropped += 1; }
      }
      if (dropped) try { this.updateDiagnostics({ droppedFiles: this.diagnostics().droppedFiles + dropped }); } catch { /* isolated */ }
    } finally { release(); }
  }

  status(now = Date.now()): QueueStatus {
    try {
      const files = this.readyFiles(); const diagnostic = this.diagnostics();
      return { queuedFiles: files.length, queuedBytes: files.reduce((sum, item) => sum + item.size, 0),
        oldestAgeMs: files[0] ? Math.max(0, now - files[0].mtimeMs) : null, ...diagnostic };
    } catch { return { queuedFiles: 0, queuedBytes: 0, oldestAgeMs: null, ...emptyDiagnostics(), lastErrorCategory: "spool" }; }
  }

  exportBundle(destination: string): { records: number; sha256: string } {
    const release = this.acquireLease(); if (!release) throw new Error("telemetry queue busy");
    try {
      const records = this.list().map(({ payload }) => { const bytes = Buffer.from(JSON.stringify(payload)); return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), payload }; });
      const bundle: TelemetryBundle = { format: "larkin-otlp-bundle", version: 1, createdAt: new Date().toISOString(), records };
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
      const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(descriptor, compressed); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return { records: records.length, sha256: crypto.createHash("sha256").update(compressed).digest("hex") };
    } finally { release(); }
  }

  importBundle(source: string, maxBundleBytes = 128 * 1024 * 1024): { imported: number; duplicates: number } {
    let descriptor: number | undefined; let bytes: Buffer;
    try {
      descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > maxBundleBytes) throw new Error("invalid telemetry bundle");
      bytes = fs.readFileSync(descriptor);
    } catch { throw new Error("invalid telemetry bundle"); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    let parsed: TelemetryBundle;
    try { parsed = JSON.parse(zlib.gunzipSync(bytes!, { maxOutputLength: maxBundleBytes }).toString("utf8")) as TelemetryBundle; }
    catch { throw new Error("invalid telemetry bundle"); }
    if (parsed.format !== "larkin-otlp-bundle" || parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 100_000) throw new Error("invalid telemetry bundle");
    const validated = parsed.records.map((record) => {
      validateOtlpPayload(record?.payload); const payloadBytes = Buffer.from(JSON.stringify(record.payload));
      const sha256 = crypto.createHash("sha256").update(payloadBytes).digest("hex");
      if (sha256 !== record.sha256) throw new Error("invalid telemetry bundle");
      return { sha256, payloadBytes };
    });
    const release = this.acquireLease(); if (!release) throw new Error("telemetry queue busy");
    const added: string[] = []; let duplicates = 0;
    try {
      for (const record of validated) {
        const destination = path.join(this.config.spoolDir, `import-${record.sha256}.json`);
        if (fs.existsSync(destination)) { duplicates += 1; continue; }
        this.atomicWrite(destination, record.payloadBytes); added.push(destination);
      }
    } catch (error) { for (const file of added) try { fs.unlinkSync(file); } catch { /* rollback best effort */ } throw error; }
    finally { release(); }
    try { this.prune(); } catch { /* isolated */ }
    return { imported: added.length, duplicates };
  }
}
